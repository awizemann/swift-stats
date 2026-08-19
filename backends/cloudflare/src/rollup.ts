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
 * Roll one closed UTC day into the three rollup tables, for both
 * `include_debug` variants, across every project.
 *
 * DELETE-then-INSERT rather than a bare `ON CONFLICT DO UPDATE`. Both are
 * idempotent for re-running the same day, but only delete-then-insert is
 * SELF-CORRECTING: after a per-`installId` erasure (§13) removed raw rows, an
 * upsert would leave behind rollup rows for values that no longer exist, and a
 * count that is too high. All statements go in one `db.batch()`, so the day is
 * never observable in a half-rolled state.
 */
export function rollupStatements(env: Env, day: string, rolledAt: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (const includeDebug of [0, 1] as const) {
    // `include_debug = 1` means "all traffic"; `0` means "debug excluded". Two
    // stored rows rather than one subtractable pair, because distinct counts do
    // not subtract: all-installs minus non-debug-installs is not the count of
    // debug-only installs.
    const debugFilter = includeDebug === 1 ? '' : 'AND e.is_debug = 0';

    statements.push(
      env.DB.prepare(
        `DELETE FROM daily_rollups WHERE day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug),
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
                ?3
           FROM events e
          WHERE e.day = ?1 ${debugFilter}
          GROUP BY e.project_id, e.day`,
      ).bind(day, includeDebug, rolledAt),

      env.DB.prepare(
        `DELETE FROM daily_event_rollups WHERE day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug),
      env.DB.prepare(
        `INSERT INTO daily_event_rollups
           (project_id, day, include_debug, name, count, installs)
         SELECT e.project_id, e.day, ?2, e.name, COUNT(*), COUNT(DISTINCT e.install_id)
           FROM events e
          WHERE e.day = ?1 ${debugFilter}
          GROUP BY e.project_id, e.day, e.name`,
      ).bind(day, includeDebug),

      env.DB.prepare(
        `DELETE FROM daily_prop_rollups WHERE day = ?1 AND include_debug = ?2`,
      ).bind(day, includeDebug),
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
        //              entirely", which is what §8.2's null row means.
        //
        // The final SELECT ranks non-null values by count and keeps the top
        // MAX_ROLLED_VALUES_PER_PROP; null rows bypass the rank and are always
        // kept, since a reader needs "did not report" even when it is rare.
        `WITH keys AS (
           SELECT DISTINCT e.project_id AS project_id, e.name AS name, j.key AS prop
             FROM events e, json_each(e.props) j
            WHERE e.day = ?1 ${debugFilter}
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
            WHERE e.day = ?1 ${debugFilter}
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
            WHERE e.day = ?1 ${debugFilter}
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
      ).bind(day, includeDebug),
    );
  }

  return statements;
}

/**
 * The Cron Trigger entry point.
 *
 * `now` is injected rather than read from `Date.now()` inside so that a test can
 * put the clock on a specific UTC day and assert the retention boundary exactly
 * — the off-by-one there is the expensive kind of bug (a day of history) and it
 * is only testable if the clock is a parameter.
 */
export async function runScheduled(env: Env, now: Date): Promise<{
  rolled: string[];
  deletedEvents: number;
  /** True when another invocation held the lease and this one did nothing. */
  skipped: boolean;
}> {
  const holder = await acquireRollupLease(env, now);
  if (holder === null) {
    logger.warn('rollup_lease_held');
    return { rolled: [], deletedEvents: 0, skipped: true };
  }
  try {
    return { ...(await runRollupAndSweep(env, now)), skipped: false };
  } finally {
    // `finally`, so a throw anywhere below cannot leave the job locked out until
    // the TTL expires.
    await releaseRollupLease(env, holder);
  }
}

async function runRollupAndSweep(env: Env, now: Date): Promise<{
  rolled: string[];
  deletedEvents: number;
}> {
  const rolledAt = now.toISOString();
  const rolled: string[] = [];

  // 1. Roll up. Yesterday first, then further back, so that if the invocation
  //    runs out of time the most important day is already done.
  for (let i = 1; i <= REROLL_DAYS; i += 1) {
    const day = addDays(today(now), -i);
    try {
      const statements = rollupStatements(env, day, rolledAt);
      statements.push(
        env.DB.prepare(
          `INSERT INTO rollup_state (day, rolled_at, event_rows)
           VALUES (?1, ?2, (SELECT COUNT(*) FROM events WHERE day = ?1))
           ON CONFLICT (day) DO UPDATE
             SET rolled_at = excluded.rolled_at, event_rows = excluded.event_rows`,
        ).bind(day, rolledAt),
      );
      await env.DB.batch(statements);
      rolled.push(day);
      logger.info('rolled_day', { day });
    } catch (cause) {
      // Keep going: a failure on an older day must not stop yesterday's roll,
      // and must certainly not let the code fall through to the delete below
      // having skipped it silently.
      logger.error('rollup_failed', { day }, cause);
    }
  }

  if (rolled.length < REROLL_DAYS) {
    logger.error('retention_skipped', { rows: rolled.length });
    return { rolled, deletedEvents: 0 };
  }

  // Each project's own cutoff (0006). The sweep is no longer one global delete:
  // a project keeping 180 days and a project keeping the default 90 share this
  // table and must not share a boundary.
  const projects = await env.DB.prepare(
    `SELECT id, retention_days AS retentionDays FROM projects`,
  ).all<{ id: string; retentionDays: number | null }>();

  const cutoffs = projects.results.map((p) => ({
    projectId: p.id,
    cutoff: rawCutoffDay(now, clampRetentionDays(p.retentionDays)),
  }));

  // The OLDEST cutoff across all projects, for logging and for the fallback
  // below. Not a delete boundary — nothing is deleted by this value.
  const cutoff = cutoffs.reduce<string>(
    (min, c) => (c.cutoff < min ? c.cutoff : min),
    rawCutoffDay(now),
  );

  // 2. Roll EVERY day that is about to be deleted.
  //
  //    The trailing window above is about freshness, not safety, and on its own
  //    it does not make the delete below safe. Three ways a day can reach the
  //    cutoff having never been rolled, all of which lose that day's history
  //    permanently and silently:
  //
  //      * The cron did not run for more than REROLL_DAYS days. The window only
  //        ever looks back four days, so nothing later re-rolls what was missed.
  //      * A batch queued offline arrives more than REROLL_DAYS days late, which
  //        §1 explicitly permits — it lands in a day the last pass already rolled
  //        and is never rolled again.
  //      * `bucketDay` clamps an implausibly old `ts` onto the *oldest surviving
  //        day* — precisely the day the next sweep keeps, and so the last day
  //        whose raw rows a pass must roll before a later sweep removes them.
  //
  //    So the set to roll is not "the last four days", it is "every day whose raw
  //    rows this pass is about to remove". In the steady state that is one day,
  //    already rolled minutes ago, and re-rolling it is cheap and idempotent.
  //
  //    Asked per project, because the set of expiring days is now per project —
  //    but note that `rollupStatements` rolls a whole DAY across every project at
  //    once. That is deliberate and still correct: rolling a day for a project
  //    that is not expiring it is idempotent and cheap, and doing it per project
  //    would mean three DELETE-then-INSERTs per project per day for no gain.
  const expiringDays = new Set<string>();
  for (const { projectId, cutoff: projectCutoff } of cutoffs) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT day FROM events WHERE project_id = ?1 AND day < ?2`,
    )
      .bind(projectId, projectCutoff)
      .all<{ day: string }>();
    for (const r of rows.results) expiringDays.add(r.day);
  }

  for (const day of [...expiringDays].sort()) {
    try {
      await env.DB.batch(rollupStatements(env, day, rolledAt));
      await env.DB.prepare(
        `INSERT INTO rollup_state (day, rolled_at, event_rows)
         VALUES (?1, ?2, (SELECT COUNT(*) FROM events WHERE day = ?1))
         ON CONFLICT (day) DO UPDATE
           SET rolled_at = excluded.rolled_at, event_rows = excluded.event_rows`,
      )
        .bind(day, rolledAt)
        .run();
      if (!rolled.includes(day)) rolled.push(day);
      logger.info('rolled_expiring_day', { day });
    } catch (cause) {
      // Abandon the delete entirely. Deleting raw rows for a day that was never
      // aggregated is the one unrecoverable operation in this backend, so a
      // failure here must stop the sweep rather than be logged and stepped over.
      logger.error('retention_skipped_unrolled_day', { day }, cause);
      return { rolled, deletedEvents: 0 };
    }
  }

  // 3. Age out raw events. Every day below `cutoff` has now been rolled by this
  //    same invocation, so nothing is deleted that is not already aggregated.
  let deletedEvents = 0;
  try {
    // `day < cutoff` deletes strictly older than the oldest day reads will look
    // for in raw rows — `rawCutoffDay` is the shared definition of that
    // boundary, so read and delete cannot drift apart into either a silently
    // zeroed day or a day served from two sources. Since 0006 that boundary is
    // per project on BOTH sides: `rawBoundaryDay` derives the read boundary from
    // the same column this loop deletes by, so a project with a longer window
    // keeps its raw rows AND reads them, and a project with the default is
    // untouched by its neighbour's setting.
    //
    // What this deliberately does NOT touch is `installs` (0005): first sighting
    // is the one fact that cannot be recovered from any aggregate, and the whole
    // reason that table exists is to outlive this delete. There is no statement
    // anywhere in the scheduled job that removes an install row — the only paths
    // that do are a project delete (the FK cascade) and the §13 per-install
    // erasure.
    for (const { projectId, cutoff: projectCutoff } of cutoffs) {
      const result = await env.DB.prepare(
        `DELETE FROM events WHERE project_id = ?1 AND day < ?2`,
      )
        .bind(projectId, projectCutoff)
        .run();
      deletedEvents += result.meta.changes ?? 0;
    }

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

    // The dedupe ledger has its own, much shorter window (§6 needs ≥ 24 h).
    // Purging it leaves `events.batch_id` pointing at absent rows; that is
    // intended and harmless — no read joins on it, and there is no enforced
    // foreign key. What it must NOT do is run before the 24-hour dedupe promise.
    await env.DB.prepare(`DELETE FROM batches WHERE received_at < ?1`)
      .bind(`${addDays(today(now), -DEDUPE_RETENTION_DAYS)}T00:00:00.000Z`)
      .run();

    logger.info('retention_swept', { day: cutoff, events: deletedEvents });
  } catch (cause) {
    logger.error('retention_failed', { day: cutoff }, cause);
  }

  return { rolled, deletedEvents };
}

export { RAW_RETENTION_DAYS };
