// The scheduled job: roll up closed days, then age out raw events.
//
// Order matters and is not negotiable. The rollup runs FIRST and the retention
// delete second, in that order, every time: schema §13 and the backend README
// promise that aggregates outlive raw rows, and the only way to keep that
// promise is to have aggregated a day before its raw rows can be removed. If
// this ever runs in the other order, a day's history is gone permanently — the
// README calls this out as the one irreversible operation in the backend.

import {
  addDays,
  clampRetentionDays,
  RAW_RETENTION_DAYS,
  rawCutoffDay,
  today,
} from './dates.js';
import { logger } from './log.js';
import { purgeExpiredErasures } from './lib/erase.js';
import type { Env } from './env.js';

/**
 * How many closed days each pass re-rolls, counting back from yesterday.
 *
 * Not 1. §1 allows a queued offline batch to arrive hours or days after its
 * events were tracked, and such a batch lands in a day that was already rolled
 * up. Re-rolling a small trailing window absorbs those without a separate
 * "dirty day" ledger. Reads inside raw retention prefer raw rows anyway, so this
 * window is about the rollups being right when the raw rows eventually go, not
 * about read freshness.
 */
export const REROLL_DAYS = 4;

/**
 * Cap on distinct VALUES stored per (project, event name, prop) per day.
 *
 * Rollups are kept indefinitely, so an unbounded value cardinality here is an
 * unbounded storage bill forever. The null row is always kept regardless of this
 * cap; among non-null values the most frequent survive. §8.2 permits a cap and
 * requires it be documented — the README states this number.
 */
export const MAX_ROLLED_VALUES_PER_PROP = 200;

/**
 * Dedupe ledger retention. §6 requires at least 24 hours; the emitter's ceiling
 * is 24 h (§7), so 30 days is a very wide margin, and `batches` is one narrow
 * row per batch so keeping it is cheap.
 */
export const DEDUPE_RETENTION_DAYS = 30;

/**
 * How long a lease is considered held before it is treated as abandoned.
 *
 * Long enough that a slow pass over a large database is not overtaken by the next
 * cron (which is 24 hours away anyway), short enough that a pass killed mid-run —
 * the isolate evicted, the invocation cut off — does not lock the job out for
 * days. A crash is the only way a lease outlives its run: the normal exit paths
 * release it.
 */
export const LEASE_TTL_MS = 30 * 60 * 1_000;

/**
 * Take the exclusive lease on the scheduled job, or return `null` if another
 * invocation holds it.
 *
 * The acquire is ONE statement, so it is atomic against a concurrent acquire: the
 * upsert's `WHERE` only lets the update through when the existing lease is older
 * than the TTL, and `meta.changes` reports whether this caller was the one that
 * wrote. A `SELECT` followed by an `INSERT` would have exactly the race the lease
 * exists to close — both passes would read "free" and both would proceed.
 *
 * Why this matters more than tidiness: two overlapping passes both reach the raw
 * retention DELETE, and their DELETE-then-INSERT rollups can interleave at the day
 * granularity such that one pass deletes rows the other had just inserted. The
 * result is a day whose rollups read as zero and whose raw rows have been removed
 * — the one unrecoverable outcome in this backend.
 */
export async function acquireRollupLease(
  env: Env,
  now: Date,
): Promise<string | null> {
  const holder = crypto.randomUUID();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - LEASE_TTL_MS).toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO rollup_lease (id, holder, acquired_at)
     VALUES (1, ?1, ?2)
     ON CONFLICT (id) DO UPDATE
       SET holder = excluded.holder, acquired_at = excluded.acquired_at
       WHERE rollup_lease.acquired_at < ?3`,
  )
    .bind(holder, nowIso, staleBefore)
    .run();

  return (result.meta.changes ?? 0) > 0 ? holder : null;
}

/**
 * Release the lease, but only if we still hold it.
 *
 * `AND holder = ?1` so a pass that overran the TTL and was superseded cannot
 * release the lease of the pass that took over from it.
 */
export async function releaseRollupLease(env: Env, holder: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM rollup_lease WHERE id = 1 AND holder = ?1`)
      .bind(holder)
      .run();
  } catch (cause) {
    // A failure to release costs at most one skipped pass, once the TTL expires.
    // It must never turn a completed run into a thrown error.
    logger.error('rollup_lease_release_failed', {}, cause);
  }
}

/**
 * Roll one closed UTC day of ONE project into the three rollup tables, for both
 * `include_debug` variants.
 *
 * DELETE-then-INSERT rather than a bare `ON CONFLICT DO UPDATE`. Both are
 * idempotent for re-running the same day, but only delete-then-insert is
 * SELF-CORRECTING: after a per-`installId` erasure (§13) removed raw rows, an
 * upsert would leave behind rollup rows for values that no longer exist, and a
 * count that is too high. All statements go in one `db.batch()`, so the day is
 * never observable in a half-rolled state.
 *
 * PER PROJECT, and that is not an optimisation. Delete-then-insert rebuilds a
 * rollup from whatever raw rows exist NOW, which is only correct for a project
 * whose raw rows for that day are all still there. Since 0006 the retention
 * window is per project, so on any given night one project may be expiring a day
 * whose raw rows a shorter-window neighbour removed months ago — and the old
 * day-wide form (`DELETE … WHERE day = ?` across every project) replaced that
 * neighbour's rollup, the only copy of its history, with nothing. The same
 * happened the night after one project's delete failed, and after a
 * `set-retention` that moved one project's window. Scoping both halves to
 * `project_id` makes a re-roll unable to reach a project that did not ask for it.
 *
 * Callers pass a project read from `projects`, which is also what keeps a raw
 * row whose project no longer exists (possible before 0008) from reaching the
 * rollup tables, whose FK to `projects` (0002) would reject it and fail the
 * whole batch.
 */
export function rollupStatements(
  env: Env,
  day: string,
  rolledAt: string,
  projectId: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (const includeDebug of [0, 1] as const) {
    // `include_debug = 1` means "all traffic"; `0` means "debug excluded". Two
    // stored rows rather than one subtractable pair, because distinct counts do
    // not subtract: all-installs minus non-debug-installs is not the count of
    // debug-only installs.
    const debugFilter = includeDebug === 1 ? '' : 'AND e.is_debug = 0';

    statements.push(
      env.DB.prepare(
        `DELETE FROM daily_rollups WHERE project_id = ?3 AND day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug, projectId),
      env.DB.prepare(
        `INSERT INTO daily_rollups
           (project_id, day, include_debug, opens, sessions, active_installs, events, rolled_at)
         SELECT e.project_id,
                e.day,
                ?2,
                SUM(CASE WHEN e.name = 'app_open' THEN 1 ELSE 0 END),
                -- §10: keyed on (installId, sessionId), never sessionId alone.
                COUNT(DISTINCT e.install_id || ':' || e.session_id),
                COUNT(DISTINCT e.install_id),
                COUNT(*),
                ?4
           FROM events e
          WHERE e.project_id = ?3 AND e.day = ?1 ${debugFilter}
          GROUP BY e.project_id, e.day`,
      ).bind(day, includeDebug, projectId, rolledAt),

      env.DB.prepare(
        `DELETE FROM daily_event_rollups WHERE project_id = ?3 AND day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug, projectId),
      env.DB.prepare(
        `INSERT INTO daily_event_rollups
           (project_id, day, include_debug, name, count, installs)
         SELECT e.project_id, e.day, ?2, e.name, COUNT(*), COUNT(DISTINCT e.install_id)
           FROM events e
          WHERE e.project_id = ?3 AND e.day = ?1 ${debugFilter}
          GROUP BY e.project_id, e.day, e.name`,
      ).bind(day, includeDebug, projectId),

      env.DB.prepare(
        `DELETE FROM daily_prop_rollups WHERE project_id = ?3 AND day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug, projectId),
      env.DB.prepare(
        // Three CTEs:
        //   `keys`   — the breakdown-eligible prop keys per event name. §8.2:
        //              only string, bool and null props; numeric props are
        //              omitted from breakdowns in v1. The two GLOBs re-assert
        //              the ^[a-z][a-z0-9_]*$ key pattern before `prop` is
        //              concatenated into a JSON path in `nulls` below — ingest
        //              already guarantees it, so this only matters for rows
        //              written by something other than the ingest path, which is
        //              exactly when it would matter.
        //   `present`— one row per (name, prop, type, value) for non-null values.
        //   `nulls`  — one row per (name, prop) folding "prop present with JSON
        //              null" together with "prop absent from the event
        //              entirely", which is what §8.2's null row means. Only for
        //              props reported at least once THAT DAY (`keys` is per
        //              day): the read path's raw branch applies the same rule, so
        //              a day answers the same null row from either store.
        //
        // The final SELECT ranks non-null values by count and keeps the top
        // MAX_ROLLED_VALUES_PER_PROP; null rows bypass the rank and are always
        // kept, since a reader needs "did not report" even when it is rare.
        `WITH keys AS (
           SELECT DISTINCT e.project_id AS project_id, e.name AS name, j.key AS prop
             FROM events e, json_each(e.props) j
            WHERE e.project_id = ?3 AND e.day = ?1 ${debugFilter}
              AND j.type IN ('text', 'true', 'false', 'null')
              AND j.key GLOB '[a-z]*'
              AND NOT j.key GLOB '*[^a-z0-9_]*'
         ),
         present AS (
           SELECT e.project_id AS project_id, e.name AS name, j.key AS prop,
                  j.type AS value_type,
                  CASE j.type WHEN 'text' THEN j.value ELSE j.type END AS value,
                  COUNT(*) AS count,
                  COUNT(DISTINCT e.install_id) AS installs
             FROM events e, json_each(e.props) j
            WHERE e.project_id = ?3 AND e.day = ?1 ${debugFilter}
              AND j.type IN ('text', 'true', 'false')
              AND j.key GLOB '[a-z]*'
              AND NOT j.key GLOB '*[^a-z0-9_]*'
            GROUP BY e.project_id, e.name, j.key, j.type, value
         ),
         nulls AS (
           SELECT e.project_id AS project_id, e.name AS name, k.prop AS prop,
                  COUNT(*) AS count,
                  COUNT(DISTINCT e.install_id) AS installs
             FROM events e
             JOIN keys k ON k.project_id = e.project_id AND k.name = e.name
            WHERE e.project_id = ?3 AND e.day = ?1 ${debugFilter}
              AND (e.props IS NULL
                   OR json_type(e.props, '$.' || k.prop) IS NULL
                   OR json_type(e.props, '$.' || k.prop) = 'null')
            GROUP BY e.project_id, e.name, k.prop
         ),
         ranked AS (
           SELECT project_id, name, prop, value_type, value, count, installs,
                  ROW_NUMBER() OVER (
                    PARTITION BY project_id, name, prop ORDER BY count DESC, value ASC
                  ) AS rn
             FROM present
         )
         INSERT INTO daily_prop_rollups
           (project_id, day, include_debug, name, prop, value_type, value_key, is_null,
            value, count, installs)
         SELECT project_id, ?1, ?2, name, prop, value_type, value, 0, value, count, installs
           FROM ranked
          WHERE rn <= ${MAX_ROLLED_VALUES_PER_PROP}
         UNION ALL
         SELECT project_id, ?1, ?2, name, prop, 'null', '', 1, NULL, count, installs
           FROM nulls
          WHERE count > 0`,
      ).bind(day, includeDebug, projectId),
    );
  }

  return statements;
}

/**
 * Default cap on D1 queries one scheduled invocation may issue.
 *
 * Every D1 binding call is a subrequest to a Cloudflare service, and a Worker
 * invocation may make **1,000 of those on Workers Free and 10,000 (configurable)
 * on Workers Paid** (developers.cloudflare.com/workers/platform/limits/#subrequests;
 * the 50-per-request figure there applies to external `fetch` only). A
 * `db.batch()` is one binding call, so one subrequest however many statements it
 * carries; each `prepare().run()/all()/first()` is one too. That is the unit
 * counted here. (The D1 limits page still lists "50 / 1,000 queries per Worker
 * invocation" and points at the same subrequest limits; the Workers page is the
 * current statement of them.)
 *
 * 900 leaves headroom under the Free limit for anything else the invocation does.
 * A Paid deployment with very many projects can raise it with the
 * `ROLLUP_QUERY_BUDGET` var (wrangler `[vars]`). Whatever the number, the pass
 * stops cleanly before it — and before PASS_WALL_BUDGET_MS — and the projects it
 * did not reach go first the next night (`projects.rolled_at`, 0007).
 *
 * Cost model, in these units (what ADOPTION.md C's capacity numbers come from):
 *
 *     fixed per night   = 1 lease + 1 project select + TAIL_QUERIES (7)  = 9
 *     per project       = 1 if it has trailing work (one batch, all REROLL_DAYS days)
 *                       + 1 + d if it has d days expiring tonight (a select, then
 *                         one roll-and-delete batch per day), d capped per night
 *                         by sweepDaysCap()
 *
 * A daily-active project past its first window costs 3 a night; at 900 that is
 * (900 - 8) / 3 = 297 such projects before work starts carrying over — if the
 * night's wall time allows it (see PASS_WALL_BUDGET_MS).
 */
export const DEFAULT_QUERY_BUDGET = 900;

/**
 * The share of a night's budget one project's expiring-day sweep may take, and
 * an absolute ceiling on its days, whichever is lower (`sweepDaysCap`).
 *
 * Without a cap, a project with a deep backlog — a `set-retention` from 400 to 90
 * is 310 expiring days — took the whole budget every night, never finished, and
 * (never finishing) stayed first in line, so every project after it went
 * un-rolled for weeks. Capped, it drains a fixed slice per night and the rest of
 * the night goes to everyone else.
 *
 * The share alone is too generous at a budget of 900 (225 days). Each day is a
 * full re-roll of one project-day — `json_each` over every event's props, three
 * DELETE-then-INSERTs for both debug variants — so a busy project's day can take
 * seconds, and 225 of them back to back would spend most of the scheduled
 * invocation's wall time on one tenant. MAX_SWEEP_DAYS_PER_PROJECT bounds that
 * to about a month of backlog per project per night: a 400 → 90 reduction
 * drains in ten nights.
 */
export const SWEEP_BUDGET_SHARE = 0.25;
export const MAX_SWEEP_DAYS_PER_PROJECT = 31;

/** Tonight's per-project expiring-day cap for a given budget. */
export function sweepDaysCap(budget: number): number {
  return Math.max(1, Math.min(MAX_SWEEP_DAYS_PER_PROJECT, Math.floor(budget * SWEEP_BUDGET_SHARE)));
}

/**
 * Wall-clock time after which the pass starts no new project work and goes to
 * its tail. A Cron Trigger invocation may run at most 15 minutes of wall time
 * (developers.cloudflare.com/workers/platform/limits); 10 leaves room for the
 * tail's purges and for one already-started batch (D1 caps a single query or
 * batch at 30 s). Measured on the real clock, not the injected `now`.
 *
 * CPU is a separate, smaller limit (10 ms on Workers Free, 30 s on Paid for a
 * daily cron). D1 round trips are I/O, not CPU, but building ~12 statements per
 * project-day is not free: a Free deployment running hundreds of projects a
 * night should watch for exceeded-CPU failures and lower the budget if they
 * appear.
 */
export const PASS_WALL_BUDGET_MS = 10 * 60 * 1_000;

/**
 * Queries the pass must keep in hand for its fixed tail, whatever happened above:
 * the `rollup_state` write, the `raw_complete_from` clear, the orphan sweep, the
 * context purge, the ledger purge, the erase-tombstone purge (0009), and the
 * lease release. (Rotation is NOT in the
 * tail: each project's `rolled_at` is written inside its own last batch.)
 */
export const TAIL_QUERIES = 7;

/**
 * The smallest budget the pass will run with, whatever `ROLLUP_QUERY_BUDGET`
 * says. Below it a hand-set tiny budget would leave no room for a single
 * project's work after the fixed cost, so nothing would ever be rotated and the
 * same project would be first — and unfinished — every night. 16 is the fixed
 * cost of 9 (lease, project select, TAIL_QUERIES = 7) plus one project's worst
 * first night at this budget: its trailing batch, a below-marker delete, the
 * expiring-day select, and `sweepDaysCap(16)` = 4 roll-and-delete batches —
 * 9 + 7 = exactly 16, nothing to spare since the tombstone purge joined the tail.
 */
export const MIN_QUERY_BUDGET = 16;

/** A countdown of D1 queries this invocation may still issue, and a wall-clock deadline. */
class QueryBudget {
  readonly total: number;
  private readonly deadline: number;
  constructor(
    private left: number,
    private readonly clock: () => number = Date.now,
    wallBudgetMs: number = PASS_WALL_BUDGET_MS,
  ) {
    this.total = left;
    this.deadline = clock() + wallBudgetMs;
  }
  /**
   * Spend `n` if it leaves the tail reserve intact and the wall-time budget is
   * not spent; `false` (spending nothing) if not.
   */
  takeKeepingTail(n = 1): boolean {
    if (this.left - n < TAIL_QUERIES || this.clock() >= this.deadline) return false;
    this.left -= n;
    return true;
  }
  /** Spend `n` unconditionally (the lease, the select, the tail itself). */
  spend(n = 1): void {
    this.left -= n;
  }
}

/** Resolve the budget: explicit option, then the `ROLLUP_QUERY_BUDGET` var. */
function budgetFor(env: Env, override: number | undefined): number {
  const raw = override ?? Number(env.ROLLUP_QUERY_BUDGET);
  const chosen = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_QUERY_BUDGET;
  return Math.max(MIN_QUERY_BUDGET, chosen);
}

/**
 * The project's CURRENT clock cutoff, computed in SQL from the row as it is at the
 * moment the statement runs — `rawCutoffDay(now, clampRetentionDays(…))` in SQL,
 * with ?1 = today. Used where a decision taken earlier in the pass (from the
 * selection query's snapshot) must be re-checked atomically against a
 * `set-retention` that landed since.
 */
const CURRENT_CUTOFF_SQL = `date(?1, '-' || (max(90, min(400, COALESCE(p.retention_days, 90))) - 1) || ' days')`;

/**
 * The Cron Trigger entry point.
 *
 * `now` is injected rather than read from `Date.now()` inside so that a test can
 * put the clock on a specific UTC day and assert the retention boundary exactly
 * — the off-by-one there is the expensive kind of bug (a day of history) and it
 * is only testable if the clock is a parameter. `queryBudget` likewise, so a test
 * can drive the multi-night resume path with a handful of projects.
 */
export async function runScheduled(
  env: Env,
  now: Date,
  options: {
    queryBudget?: number;
    /** Test seams for the wall-time stop: the clock it reads and its allowance. */
    clock?: () => number;
    wallBudgetMs?: number;
  } = {},
): Promise<{
  rolled: string[];
  deletedEvents: number;
  /** True when another invocation held the lease and this one did nothing. */
  skipped: boolean;
}> {
  const budget = new QueryBudget(budgetFor(env, options.queryBudget), options.clock, options.wallBudgetMs);
  budget.spend(1); // the lease acquire below
  const holder = await acquireRollupLease(env, now);
  if (holder === null) {
    logger.warn('rollup_lease_held');
    return { rolled: [], deletedEvents: 0, skipped: true };
  }
  try {
    return { ...(await runRollupAndSweep(env, now, budget)), skipped: false };
  } finally {
    // `finally`, so a throw anywhere below cannot leave the job locked out until
    // the TTL expires. Its query is part of TAIL_QUERIES, reserved throughout.
    await releaseRollupLease(env, holder);
  }
}

interface ProjectWork {
  readonly projectId: string;
  /** Clock cutoff for the project's window: raw rows below it expire tonight. */
  readonly cutoff: string;
  /** `raw_complete_from` (0007), or NULL. */
  readonly marker: string | null;
  /** Oldest raw day, or NULL for none. */
  readonly oldest: string | null;
  /** Raw rows or rollups inside the trailing window: it needs re-rolling. */
  readonly recent: boolean;
}

async function runRollupAndSweep(env: Env, now: Date, budget: QueryBudget): Promise<{
  rolled: string[];
  deletedEvents: number;
}> {
  const rolledAt = now.toISOString();
  const todayDay = today(now);
  const trailingDays = Array.from({ length: REROLL_DAYS }, (_, i) => addDays(todayDay, -(i + 1)));
  const trailingFrom = trailingDays[trailingDays.length - 1] as string;

  // ONE query decides which projects have work tonight and in what order.
  //
  // Every pass below iterates THIS list, never "whatever `events` holds": a raw
  // row whose project was deleted before 0008 added the cascade has no project
  // to roll into (the rollup tables' FK would reject it), and must not be able to
  // fail a live project's day.
  //
  // Per project, two index probes on `events_scope` and one on the
  // `daily_rollups` primary key — a few rows read each, not a scan:
  //   * `oldest` — whether anything is below its cutoff (the sweep has work);
  //   * `recent` — raw rows OR rollups in the trailing window. Rollups too,
  //     because a §13 erasure that empties a recent day leaves a rollup to
  //     correct and no raw row to say so.
  // A project with neither costs nothing more tonight, and is not written to.
  //
  // Order: least recently VISITED first (`rolled_at`, 0007; never-visited first
  // of all), project id as the tiebreak. A project the budget did not reach
  // tonight keeps its old `rolled_at` and so goes first tomorrow; a project that
  // was reached — even one whose backlog was only partly drained under its
  // `sweepDaysCap` — goes to the back. That is what keeps one project's
  // backlog, or simply the first few ids, from starving everyone after them.
  const projects = await env.DB.prepare(
    `SELECT p.id,
            p.retention_days AS retentionDays,
            p.raw_complete_from AS marker,
            (SELECT MIN(day) FROM events e WHERE e.project_id = p.id) AS oldest,
            (EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.id AND e.day >= ?1)
             OR EXISTS (SELECT 1 FROM daily_rollups r WHERE r.project_id = p.id AND r.day >= ?1)) AS recent
       FROM projects p
      ORDER BY p.rolled_at IS NOT NULL, p.rolled_at, p.id`,
  )
    .bind(trailingFrom)
    .all<{ id: string; retentionDays: number | null; marker: string | null; oldest: string | null; recent: number }>();
  budget.spend(1);

  const all: ProjectWork[] = projects.results.map((p) => ({
    projectId: p.id,
    cutoff: rawCutoffDay(now, clampRetentionDays(p.retentionDays)),
    marker: p.marker,
    oldest: p.oldest,
    recent: p.recent === 1,
  }));

  // The OLDEST cutoff across all projects: the orphan sweep's boundary and the
  // value logged. Never a delete boundary for a live project.
  const cutoff = all.reduce<string>((min, c) => (c.cutoff < min ? c.cutoff : min), rawCutoffDay(now));

  // Per-project ceiling on expiring days tonight.
  const maxSweepDays = sweepDaysCap(budget.total);

  const failedDays = new Set<string>();
  const rolledExpiring = new Set<string>();
  let deletedEvents = 0;
  let unreached = 0;
  let backlogged = 0;
  let didTrailing = false;

  for (let i = 0; i < all.length; i += 1) {
    const work = all[i] as ProjectWork;
    const expiring = work.oldest !== null && work.oldest < work.cutoff;
    if (!work.recent && !expiring) continue; // idle: no query, no write

    // 1. The trailing re-roll: ONE `db.batch()` for all REROLL_DAYS days of this
    //    project (yesterday first). One query against the budget instead of
    //    four, and each batch is still bounded by one project's few days rather
    //    than the deployment's. The days are rolled together or not at all.
    if (work.recent) {
      if (!budget.takeKeepingTail(1)) {
        unreached = all.length - i;
        break;
      }
      didTrailing = true;
      try {
        await env.DB.batch([
          ...trailingDays.flatMap((day) => rollupStatements(env, day, rolledAt, work.projectId)),
          // A project with nothing expiring is done after this batch, so its
          // rotation commits WITH it (see `rotateStatement`).
          ...(expiring ? [] : [rotateStatement(env, work.projectId, rolledAt)]),
        ]);
      } catch (cause) {
        // Keep going: a failure on one project must not stop anyone else's
        // yesterday, and must certainly not let the code fall through to this
        // project's delete below having skipped it silently. Only THIS
        // project's sweep is skipped; before, one failure anywhere skipped
        // retention for every project.
        for (const d of trailingDays) failedDays.add(d);
        logger.error('rollup_failed', { day: trailingDays[0], projectId: work.projectId }, cause);
        logger.error('retention_skipped', { projectId: work.projectId });
        continue;
      }
    }

    // 2–3. The sweep. Its own try/catch per project: a fault in one project's
    //      sweep (a query limit, a transient D1 error) is logged and the loop
    //      moves on. It used to abort the delete loop for every project after it.
    if (expiring) {
      try {
        const result = await sweepProject(env, work, todayDay, rolledAt, budget, maxSweepDays);
        deletedEvents += result.deleted;
        for (const d of result.rolled) rolledExpiring.add(d);
        if (result.stop === 'budget') {
          // Out of budget mid-project. If any of its days ran it has rotated
          // (each day batch carries its `rolled_at`); if none did it is first
          // tomorrow. The sweep is per day, so nothing it did is undone.
          unreached = all.length - i;
          break;
        }
        if (result.stop === 'cap') {
          backlogged += 1;
          logger.warn('retention_backlog', { projectId: work.projectId, rows: result.rolled.length });
        }
      } catch (cause) {
        logger.error('retention_failed', { projectId: work.projectId, day: work.cutoff }, cause);
      }
    }
  }

  if (unreached > 0 || backlogged > 0) {
    // Not an error, but an operator should see it: work carried to tomorrow.
    // `rows` is how many projects the budget did not reach at all; `events`
    // how many were reached but still have expiring days left. Sustained
    // non-zero `rows` means the deployment has outgrown ROLLUP_QUERY_BUDGET
    // (ADOPTION.md C).
    logger.warn('rollup_work_left', { rows: unreached, events: backlogged });
  }

  // `rolled`: a trailing day counts only when its rollups actually ran and every
  // project that needed it got it — no failure, and no project left unreached
  // by the budget. A night on which no project had trailing work rolled nothing.
  const rolled = unreached > 0 || !didTrailing ? [] : trailingDays.filter((d) => !failedDays.has(d));
  for (const d of [...rolledExpiring].sort()) if (!rolled.includes(d)) rolled.push(d);

  // ---- The tail. Reserved in TAIL_QUERIES, so it always has the budget. ----

  // Bookkeeping, ONE statement for every day this pass rolled. `event_rows` is a
  // cross-project count per day, so it is computed once per day here rather than
  // once per (project, day).
  budget.spend(1);
  await recordRolled(env, rolled, rolledAt);

  // `raw_complete_from` is cleared once the window's own cutoff has passed it —
  // from then on it constrains nothing (`rawFloorDay`). Decided IN SQL from the
  // row as it is now, not from the snapshot above: a `set-retention` that raised
  // the window during this pass has just written a newer marker the new, older
  // cutoff has not passed, and clearing it would re-open exactly the days it
  // protects.
  budget.spend(1);
  try {
    await env.DB.prepare(
      `UPDATE projects AS p SET raw_complete_from = NULL
        WHERE p.raw_complete_from IS NOT NULL
          AND p.raw_complete_from <= ${CURRENT_CUTOFF_SQL}`,
    )
      .bind(todayDay)
      .run();
  } catch (cause) {
    logger.error('rollup_state_failed', {}, cause);
  }

  // 4. Orphans: raw rows whose project no longer exists. 0008 makes them
  //    impossible from here on (FK + cascade) and removes the ones that exist when
  //    it runs; this covers a Worker deployed ahead of that migration, without
  //    turning into a nightly scan once it has run. The `day < cutoff` predicate
  //    is the OLDEST live cutoff, so the `events_day` range it reads holds only
  //    rows every live project has already swept — in the steady state, nothing
  //    — and an orphan is simply aged out on the longest window in use rather than
  //    found by a full-table `NOT IN`. Never rolled: there is no project to roll
  //    it into.
  budget.spend(1);
  try {
    const result = await env.DB.prepare(
      `DELETE FROM events
        WHERE day < ?1 AND project_id NOT IN (SELECT id FROM projects)`,
    )
      .bind(cutoff)
      .run();
    deletedEvents += result.meta.changes ?? 0;
  } catch (cause) {
    logger.error('retention_failed', { day: cutoff }, cause);
  }

  budget.spend(1);
  try {
    // Context rows follow their events: they are diagnostic only (nothing in the
    // v1 read contract is dimensioned by them), so they have no reason to
    // outlive the rows they describe.
    //
    // No time predicate at all, deliberately. A context row is written in the
    // same transaction as its events, so "has no events left" already means
    // "its events were deleted" and nothing else — whereas keying on the
    // emitter-supplied `sent_at` would strand a row forever behind a device with
    // a wrong forward clock. `NOT EXISTS` over the `events_batch` index is one
    // probe per candidate row, rather than the scan a `NOT IN (SELECT …)` costs.
    await env.DB.prepare(
      `DELETE FROM batch_context
        WHERE NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.batch_id = batch_context.batch_id
             AND e.project_id = batch_context.project_id
        )`,
    ).run();
  } catch (cause) {
    logger.error('retention_failed', { day: cutoff }, cause);
  }

  budget.spend(1);
  try {
    // The dedupe ledger has its own, much shorter window (§6 needs ≥ 24 h).
    // Purging it leaves `events.batch_id` pointing at absent rows; that is
    // intended and harmless — no read joins on it, and the only foreign key on
    // either table (0008) is to `projects`. What it must NOT do is run before the
    // 24-hour dedupe promise.
    await env.DB.prepare(`DELETE FROM batches WHERE received_at < ?1`)
      .bind(`${addDays(todayDay, -DEDUPE_RETENTION_DAYS)}T00:00:00.000Z`)
      .run();
  } catch (cause) {
    logger.error('retention_failed', { day: cutoff }, cause);
  }

  budget.spend(1);
  try {
    // Erase tombstones (0009) past their bound: the project's window plus a
    // month after the last erase call. One statement, capped at
    // ERASURE_PURGE_ROWS; ingest already ignores an expired tombstone, so a
    // backlog here is only rows kept a little longer, never a behaviour change.
    const purged = await purgeExpiredErasures(env.DB, now);
    if (purged > 0) logger.info('erasures_purged', { rows: purged });
  } catch (cause) {
    logger.error('erasure_purge_failed', {}, cause);
  }

  logger.info('retention_swept', { day: cutoff, events: deletedEvents });
  return { rolled, deletedEvents };
}

/**
 * Rotation (0007): mark a project visited, moving it to the back of tomorrow's
 * order. Written INSIDE the project's own batch — its trailing re-roll when it
 * has nothing expiring, otherwise every roll-and-delete day batch — rather than
 * once in the pass's tail. A pass killed part-way (Workers Free allows a cron
 * 10 ms of CPU; any invocation can be evicted) never reaches its tail, and a
 * rotation that lived there was lost with it: the same projects came first, and
 * were cut off, night after night. In the batch, rotation commits exactly when
 * the work it records does. One row written per batch.
 */
function rotateStatement(env: Env, projectId: string, rolledAt: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE projects SET rolled_at = ?1 WHERE id = ?2`).bind(rolledAt, projectId);
}

/** Bookkeeping: what ran, for an operator. Never a reason to fail a pass. */
async function recordRolled(env: Env, days: string[], rolledAt: string): Promise<void> {
  if (days.length === 0) return;
  // ≤ 99 bound parameters per statement (D1). More rolled days than that in one
  // pass only happens on a long backlog; the newest are the useful ones.
  const list = [...days].sort().reverse().slice(0, 98);
  try {
    await env.DB.prepare(
      `WITH d(day) AS (VALUES ${list.map((_, i) => `(?${i + 2})`).join(', ')})
       INSERT INTO rollup_state (day, rolled_at, event_rows)
       SELECT d.day, ?1, (SELECT COUNT(*) FROM events e WHERE e.day = d.day) FROM d WHERE true
       ON CONFLICT (day) DO UPDATE
         SET rolled_at = excluded.rolled_at, event_rows = excluded.event_rows`,
    )
      .bind(rolledAt, ...list)
      .run();
  } catch (cause) {
    logger.error('rollup_state_failed', {}, cause);
  }
}

/**
 * Steps 2 and 3 for ONE project: roll every day it is about to delete, and
 * delete it in the same `db.batch()`. Returns the rows deleted, the days
 * rolled, and why it stopped early, if it did: `'cap'` (this project's share of
 * tonight's budget, SWEEP_BUDGET_SHARE, is spent — the backlog continues
 * tomorrow) or `'budget'` (the night's budget is spent).
 *
 * 2. Roll EVERY day that is about to be deleted.
 *
 *    The trailing window above is about freshness, not safety, and on its own
 *    it does not make the delete below safe. Three ways a day can reach the
 *    cutoff having never been rolled, all of which lose that day's history
 *    permanently and silently:
 *
 *      * The cron did not run for more than REROLL_DAYS days. The window only
 *        ever looks back four days, so nothing later re-rolls what was missed.
 *      * A batch queued offline arrives more than REROLL_DAYS days late, which
 *        §1 explicitly permits — it lands in a day the last pass already rolled
 *        and is never rolled again.
 *      * `bucketDay` clamps an implausibly old `ts` onto the *oldest surviving
 *        day* — precisely the day the next sweep keeps, and so the last day
 *        whose raw rows a pass must roll before a later sweep removes them.
 *
 *    So the set to roll is not "the last four days", it is "every day whose raw
 *    rows this pass is about to remove". In the steady state that is one day,
 *    already rolled minutes ago, and re-rolling it is cheap and idempotent.
 *
 *    EXCEPT below `raw_complete_from` (0007). Those days were swept under an
 *    older, shorter window; their rollups are the complete record and any raw
 *    row there is a stray (written before ingest clamped to the marker). Rolling
 *    it would replace the day's real history with the stray's count, so below
 *    the marker raw rows are deleted WITHOUT being rolled.
 *
 * 3. Delete, per DAY, in the same batch as that day's roll — so a day is rolled
 *    and gone, or neither — rather than one `day < cutoff` statement:
 *
 *      * Bounded statements. One `DELETE` over a project's whole backlog (a
 *        `set-retention` from 400 down to 90 is 310 days of rows) can exceed
 *        D1's per-statement limits; one project-day is the natural unit.
 *      * NOT a `LIMIT`/rowid loop, deliberately. A chunked delete interrupted
 *        mid-day leaves a day with SOME of its raw rows — and the next night's
 *        step 2 would re-roll that day from the survivors, replacing a complete
 *        rollup with a partial one. Each batch here removes a whole day or
 *        nothing, so a day's raw rows are always all there or all gone.
 *
 *    Every DELETE re-checks the project's window IN SQL, from the row as it is
 *    when the statement runs (`CURRENT_CUTOFF_SQL`), not from the snapshot the
 *    pass started with. A `set-retention` raise that lands mid-pass moves the
 *    cutoff back (and sets a marker at or below these days, which are complete):
 *    the day is no longer expiring, and the delete becomes a no-op instead of
 *    removing raw rows the new window keeps. The roll in front of it is
 *    harmless either way — the day's raw rows are complete, so its rollup is
 *    simply rebuilt as it already was.
 *
 *    A failure stops this project's sweep at that day: earlier days are rolled
 *    and gone, later ones keep their raw rows and are retried tomorrow.
 */
async function sweepProject(
  env: Env,
  work: ProjectWork,
  todayDay: string,
  rolledAt: string,
  budget: QueryBudget,
  maxDays: number,
): Promise<{ deleted: number; rolled: string[]; stop: 'cap' | 'budget' | null }> {
  const { projectId, cutoff: projectCutoff, marker } = work;
  let deleted = 0;
  const rolled: string[] = [];

  // Strays below the marker: delete, never roll. Bounded by the marker AND the
  // current cutoff, both read in SQL at the moment of the delete.
  if (marker !== null && work.oldest !== null && work.oldest < marker) {
    if (!budget.takeKeepingTail(1)) return { deleted, rolled, stop: 'budget' };
    const result = await env.DB.prepare(
      `DELETE FROM events
        WHERE project_id = ?2
          AND day < (SELECT min(COALESCE(p.raw_complete_from, ''), ${CURRENT_CUTOFF_SQL})
                       FROM projects p WHERE p.id = ?2)`,
    )
      .bind(todayDay, projectId)
      .run();
    deleted += result.meta.changes ?? 0;
    logger.warn('retention_dropped_below_marker', { projectId, rows: result.meta.changes ?? 0 });
  }

  // `day < cutoff` deletes strictly older than the oldest day reads will look for
  // in raw rows — `rawCutoffDay` is the shared definition of that boundary. Since
  // 0006 it is per project, so a project with a longer window keeps its raw rows
  // and a project with the default is untouched by its neighbour's setting. At
  // most `maxDays + 1` rows come back: one more than tonight's cap, to know
  // whether the cap is what stopped it.
  if (!budget.takeKeepingTail(1)) return { deleted, rolled, stop: 'budget' };
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT day FROM events WHERE project_id = ?1 AND day < ?2 ORDER BY day LIMIT ?3`,
  )
    .bind(projectId, projectCutoff, maxDays + 1)
    .all<{ day: string }>();

  for (const [index, { day }] of results.entries()) {
    if (index >= maxDays) return { deleted, rolled, stop: 'cap' };
    // Roll and delete are ONE batch: one query, and atomic.
    if (!budget.takeKeepingTail(1)) return { deleted, rolled, stop: 'budget' };
    let changes = 0;
    try {
      const results2 = await env.DB.batch([
        ...rollupStatements(env, day, rolledAt, projectId),
        rotateStatement(env, projectId, rolledAt),
        // What this deliberately does NOT touch is `installs` (0005): first
        // sighting is the one fact that cannot be recovered from any aggregate,
        // and the whole reason that table exists is to outlive this delete.
        // There is no statement anywhere in the scheduled job that removes an
        // install row — the only paths that do are a project delete (the FK
        // cascade) and the §13 per-install erasure.
        env.DB.prepare(
          `DELETE FROM events
            WHERE project_id = ?2 AND day = ?3
              AND ?3 < (SELECT ${CURRENT_CUTOFF_SQL} FROM projects p WHERE p.id = ?2)`,
        ).bind(todayDay, projectId, day),
      ]);
      changes = results2[results2.length - 1]?.meta.changes ?? 0;
    } catch (cause) {
      // Neither the roll nor the delete happened (one transaction). Stop this
      // project's sweep: deleting raw rows for a day that was never aggregated is
      // the one unrecoverable operation in this backend.
      logger.error('retention_skipped_unrolled_day', { projectId, day }, cause);
      return { deleted, rolled, stop: null };
    }
    rolled.push(day);
    deleted += changes;
    logger.info('rolled_expiring_day', { projectId, day });
  }
  return { deleted, rolled, stop: null };
}

export { RAW_RETENTION_DAYS };
