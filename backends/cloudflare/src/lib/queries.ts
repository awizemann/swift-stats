// The read contract, as plain functions over a `D1Database`.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR WHAT A NUMBER MEANS.
//
// `src/read.ts` is an HTTP shell over it: auth, query-string parsing, response
// envelopes. Everything that decides a *value* — which days come from raw rows
// and which from the rollups, how sessions are keyed, the prop cap, the sort
// order, the zero-fill, the date validation and clamping — lives here, so a
// sibling Worker bound to the SAME D1 (the swiftstats.co dashboard) can import
// it and cannot drift from the public API's answers. A dashboard that
// re-implemented these queries would be wrong the first time either side
// changed, and nothing would say so.
//
// Constraints this module holds to, because a consumer may be a different
// Worker, a test, or a Node script:
//
//   * No `Request`, no `Response`, no router, no `Env` — a `D1Database` and
//     plain values in, plain values out.
//   * No Worker-only global is touched at module scope. (`HttpError.toResponse`
//     constructs a `Response`, but only if a consumer calls it; validation
//     failures are ordinary throws carrying a stable code and message.)
//   * `now` is always a parameter, never `new Date()` read in here. The
//     raw/rollup boundary and the `to` clamp are both clock-dependent, and
//     they are only testable if the clock is injectable.
//
// Every day in a requested range is answered from exactly one source:
//
//     day >= rawCutoff  ->  raw `events` rows      (exact distinct counts)
//     day <  rawCutoff  ->  the daily rollup tables (see the caveat below)
//
// The boundary is the retention sweep's, so the two sets are disjoint and
// complete. Preferring raw inside the window is what makes a late-arriving
// offline batch (§1: a queued batch can be hours or days old) visible
// immediately, without waiting for the next rollup pass.
//
// THE ONE INEXACTNESS, stated here and in the README because
// backends/README.md item 6 requires it: `sessions`, `activeInstalls` and
// `installs` are EXACT for every summary row and for any top-events range that
// lies wholly inside raw retention. A per-day rollup row stores a per-day
// distinct count, and distinct counts are not additive — so `topEvents`'
// `installs`, which is a distinct count over the whole range, becomes an UPPER
// BOUND once the range reaches back past raw retention. `summary` is
// unaffected: its rows are per-day, which is the granularity the rollups store.

import { badRequest } from '../errors.js';
import {
  addDays,
  daysInclusive,
  eachDay,
  isValidDate,
  MAX_RANGE_DAYS,
  rawCutoffDay,
  today,
} from '../dates.js';

// -----------------------------------------------------------------------------
// Shared constants and patterns
// -----------------------------------------------------------------------------

/** The `projectId` shape a read request may name (§8). */
export const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The prop-key shape §2.3 constrains at ingest, re-asserted on the way out. */
const PROP_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The event-name shape §8.2 accepts on `?name=`. */
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Cap on how many distinct `prop` keys one named breakdown will return. §8.2
 * permits a cap and requires it be documented; the README states this number.
 * The 20 kept are the most frequent props for that event name in the range,
 * `prop` ascending as a deterministic tiebreak.
 */
export const MAX_BREAKDOWN_PROPS = 20;

// -----------------------------------------------------------------------------
// Range resolution
// -----------------------------------------------------------------------------

/** What a caller asks for. `projectId` is assumed already authorized. */
export interface RangeRequest {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
  readonly includeDebug?: boolean;
}

/** What is actually served, after clamping and raw/rollup routing. */
export interface ResolvedRange {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
  readonly includeDebug: boolean;
  /** `null` when the whole range is served from raw rows. */
  readonly rollupTo: string | null;
  /** `null` when the whole range is older than raw retention. */
  readonly rawFrom: string | null;
}

/**
 * Validate a `from`/`to` pair and clamp `to` to today (UTC), or throw.
 *
 * Pure and database-free, and separate from `resolveDayRange` so the HTTP layer
 * can run the §8 checks in their fixed order — a caller must be able to get the
 * date 400s out before it parses anything else.
 *
 * Throws `HttpError` (400) with the stable codes `invalid_range` and
 * `range_too_large`.
 */
export function clampAndValidateDays(
  fromRaw: string,
  toRaw: string,
  now: Date,
): { from: string; to: string } {
  if (!isValidDate(fromRaw) || !isValidDate(toRaw)) {
    throw badRequest('invalid_range', '`from` and `to` must be real calendar days as YYYY-MM-DD.');
  }

  // §8.1: a `to` after today (UTC) is CLAMPED to today, so the response never
  // contains a future row. Clamping happens BEFORE the ordering and span
  // checks, because §8.1 defines the span as "after clamping".
  const maxDay = today(now);
  const to = toRaw > maxDay ? maxDay : toRaw;
  const from = fromRaw;

  // Note the interaction, which is deliberate: a range lying wholly in the
  // future (`from` and `to` both after today) clamps `to` down to today and then
  // fails this check with a 400. That is the right answer — a request for days
  // that have not happened is a caller bug, and §8.1 guarantees the response
  // never contains a future row, so the only alternative would be an all-zero
  // body that looks like real data.
  if (to < from) {
    throw badRequest('invalid_range', '`to` must not be before `from`.');
  }
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) {
    throw badRequest('range_too_large', `A range may span at most ${MAX_RANGE_DAYS} days.`);
  }

  return { from, to };
}

/**
 * Validate and clamp a requested range, then route its days to raw or rollup.
 *
 * Pure: `rawFromDay` is supplied by the caller (see `rawBoundaryDay`), so this
 * can be exercised without a database.
 *
 * Throws `HttpError` (400) with the stable codes `invalid_range` and
 * `range_too_large`. Authorization is NOT done here — a caller must have
 * already established that its key covers `projectId`, because §8 fixes the
 * check order at key -> scope -> dates. Doing dates first would let an
 * unauthenticated caller distinguish a 400 from a 401 and so probe which
 * projects exist.
 */
export function resolveDayRange(
  request: RangeRequest,
  rawFromDay: string,
  now: Date,
): ResolvedRange {
  const { from, to } = clampAndValidateDays(request.from, request.to, now);

  // `rawFromDay` is the OBSERVED boundary (see `rawBoundaryDay`), not the clock's
  // — every day at or above it is answered from raw rows, every day below it from
  // the rollups, and the two sets stay disjoint and complete.
  return {
    projectId: request.projectId,
    from,
    to,
    includeDebug: request.includeDebug === true,
    rawFrom: to < rawFromDay ? null : (from > rawFromDay ? from : rawFromDay),
    rollupTo: from >= rawFromDay ? null : (to < rawFromDay ? to : addDays(rawFromDay, -1)),
  };
}

/**
 * The oldest day this read will answer from raw event rows.
 *
 * The clock alone gets this wrong, and the window is real. `rawCutoffDay(now)` is
 * `today - 89`, while the retention sweep that actually deletes `day < cutoff`
 * runs on a cron at **02:10 UTC**. So between 00:00 and 02:10 every day, `today`
 * has already ticked over but the sweep has not run: day `today - 90` still has
 * all its raw rows, and the clock-derived boundary routed it to the rollups
 * anyway. If that day's rollup was never written — the cron was down while the
 * day was inside the re-roll window, the rollup failed for it, a batch for it
 * arrived after it left the window — the day read as a confident, zero-filled
 * ZERO while its raw rows sat right there in the table. §8.1 promises a row per
 * day and no way to distinguish "no data" from "missing row", which makes a false
 * zero indistinguishable from the truth.
 *
 * So the boundary is derived from observed state instead: the oldest day for which
 * raw rows exist, when that is older than the clock's cutoff. A day never reads as
 * zero while its raw rows exist.
 *
 * Both directions of the resulting boundary stay safe:
 *
 *  * Surviving raw rows are always a contiguous SUFFIX `[minDay, today]` — the
 *    sweep deletes `day < cutoff` and `cutoff` only moves forward — so no day
 *    above the boundary can be missing raw rows that a rollup would have covered.
 *    (The one exception is a per-`installId` erasure emptying a day, and there
 *    reading zero from raw is the *correct* answer; the day's stale rollup is the
 *    wrong one.)
 *  * Below the boundary there are no raw rows at all, so the rollups cannot
 *    double-count with them.
 *
 * One indexed `MIN(day)` on `events_scope`, scoped to the project.
 */
export async function rawBoundaryDay(
  db: D1Database,
  projectId: string,
  now: Date,
): Promise<string> {
  const cutoff = rawCutoffDay(now);
  const row = await db
    .prepare(`SELECT MIN(day) AS oldest FROM events WHERE project_id = ?1`)
    .bind(projectId)
    .first<{ oldest: string | null }>();

  const oldest = row?.oldest ?? null;
  if (oldest === null) return cutoff;
  // Never move the boundary UP past the clock's cutoff: a project whose oldest
  // raw row is recent (a new project, or one that went quiet) must still have its
  // older days served from rollups rather than reported as zero.
  return oldest < cutoff ? oldest : cutoff;
}

/**
 * Validate, then resolve the raw/rollup boundary against observed state.
 *
 * The validation pass runs FIRST with the clock's cutoff, purely to get the
 * 400s out of the way in the order §8 fixes, before any query touches D1. Its
 * `rawFrom`/`rollupTo` are discarded.
 *
 * A caller must already have authorized `projectId` against its key.
 */
export async function resolveRange(
  db: D1Database,
  request: RangeRequest,
  now: Date,
): Promise<ResolvedRange> {
  const validated = resolveDayRange(request, rawCutoffDay(now), now);
  const boundary = await rawBoundaryDay(db, validated.projectId, now);
  return resolveDayRange(request, boundary, now);
}

/** Which store(s) answered a resolved range. For logging and diagnostics. */
export function rangeSource(range: ResolvedRange): 'raw' | 'rollup' | 'mixed' {
  if (range.rawFrom !== null && range.rollupTo !== null) return 'mixed';
  return range.rawFrom !== null ? 'raw' : 'rollup';
}

/** `AND is_debug = 0` unless the caller asked for debug traffic (§8.1 default). */
function debugClause(includeDebug: boolean): string {
  return includeDebug ? '' : ' AND is_debug = 0';
}

// -----------------------------------------------------------------------------
// Parameter parsing
//
// These live here, not in the HTTP layer, because they are part of the read
// CONTRACT: a consumer reading `?limit=` off its own URL must reject exactly
// what the public API rejects, with the same code and the same message.
// -----------------------------------------------------------------------------

/** `null` (absent) -> `false`. Anything but `true`/`false` is a 400 (§8.1). */
export function parseIncludeDebug(raw: string | null): boolean {
  if (raw === null) return false;
  if (raw !== 'true' && raw !== 'false') {
    throw badRequest('bad_request', '`includeDebug` must be `true` or `false`.');
  }
  return raw === 'true';
}

/** `null` (absent) -> `DEFAULT_LIMIT`. Out of 1..100, or non-integer, is a 400. */
export function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  // §8.2: out of range OR non-integer -> 400. `Number('20abc')` is NaN and
  // `Number('')` is 0, both of which fail below; the explicit integer regex
  // additionally rejects `20.0` and `2e1`, which Number() would happily accept.
  if (!/^\d+$/.test(raw)) {
    throw badRequest('invalid_limit', '`limit` must be an integer between 1 and 100.');
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) {
    throw badRequest('invalid_limit', '`limit` must be an integer between 1 and 100.');
  }
  return n;
}

/**
 * `null` (absent) -> `null`, meaning "top names rather than a breakdown".
 *
 * A syntactically invalid name is a malformed parameter -> 400. A well-formed
 * but unknown name is an empty result (§8.2), which falls out of the queries
 * naturally.
 */
export function parseEventName(raw: string | null): string | null {
  if (raw === null) return null;
  if (!EVENT_NAME_RE.test(raw)) {
    throw badRequest('bad_request', '`name` must match ^[a-z][a-z0-9_]*$.');
  }
  return raw;
}

/**
 * Both `from` and `to` are required (§8.1). Separate from `resolveDayRange` so
 * the "missing" and "malformed" 400s keep their distinct messages.
 */
export function requireBothDays(from: string | null, to: string | null): { from: string; to: string } {
  if (from === null || to === null) {
    throw badRequest('invalid_range', 'Both `from` and `to` are required (YYYY-MM-DD, UTC).');
  }
  return { from, to };
}

// -----------------------------------------------------------------------------
// Byte order
// -----------------------------------------------------------------------------

/** Byte-wise ascending over UTF-8 (§0). */
export const byteCompare = (() => {
  const enc = new TextEncoder();
  return (a: string, b: string): number => {
    const ab = enc.encode(a);
    const bb = enc.encode(b);
    const n = Math.min(ab.length, bb.length);
    for (let i = 0; i < n; i += 1) {
      const d = (ab[i] as number) - (bb[i] as number);
      if (d !== 0) return d;
    }
    return ab.length - bb.length;
  };
})();

// -----------------------------------------------------------------------------
// summary
// -----------------------------------------------------------------------------

export interface SummaryRow {
  readonly date: string;
  readonly opens: number;
  readonly sessions: number;
  readonly activeInstalls: number;
  readonly events: number;
}

interface SummaryCounts {
  opens: number;
  sessions: number;
  activeInstalls: number;
  events: number;
}

/**
 * Per-day counts for an already-resolved range.
 *
 * §8.1: a row for EVERY day in the served range, ascending, zero-filled where
 * there is no data — so a consumer chart can trust the row count and never has
 * to tell "no data" from "missing row".
 */
export async function summaryRows(db: D1Database, range: ResolvedRange): Promise<SummaryRow[]> {
  const byDay = new Map<string, SummaryCounts>();

  if (range.rawFrom !== null) {
    const { results } = await db
      .prepare(
        `SELECT day,
                SUM(CASE WHEN name = 'app_open' THEN 1 ELSE 0 END) AS opens,
                -- §10: a sessionId is NOT globally unique; sessions are keyed on
                -- (installId, sessionId). COUNT(DISTINCT session_id) would merge
                -- two installs that started a session in the same second.
                -- install_id is a fixed 64 hex chars, so the ':' join cannot be
                -- ambiguous no matter what a session_id contains.
                COUNT(DISTINCT install_id || ':' || session_id) AS sessions,
                COUNT(DISTINCT install_id) AS activeInstalls,
                COUNT(*) AS events
           FROM events
          WHERE project_id = ?1 AND day >= ?2 AND day <= ?3${debugClause(range.includeDebug)}
          GROUP BY day`,
      )
      .bind(range.projectId, range.rawFrom, range.to)
      .all<{ day: string; opens: number; sessions: number; activeInstalls: number; events: number }>();

    for (const r of results) {
      byDay.set(r.day, {
        opens: r.opens,
        sessions: r.sessions,
        activeInstalls: r.activeInstalls,
        events: r.events,
      });
    }
  }

  if (range.rollupTo !== null) {
    const { results } = await db
      .prepare(
        `SELECT day, opens, sessions, active_installs AS activeInstalls, events
           FROM daily_rollups
          WHERE project_id = ?1 AND include_debug = ?2 AND day >= ?3 AND day <= ?4`,
      )
      .bind(range.projectId, range.includeDebug ? 1 : 0, range.from, range.rollupTo)
      .all<{ day: string; opens: number; sessions: number; activeInstalls: number; events: number }>();

    for (const r of results) {
      byDay.set(r.day, {
        opens: r.opens,
        sessions: r.sessions,
        activeInstalls: r.activeInstalls,
        events: r.events,
      });
    }
  }

  // `eachDay` is the only thing that decides the row set; the queries above
  // only fill it in.
  return eachDay(range.from, range.to).map((day) => {
    const c = byDay.get(day);
    return {
      date: day,
      opens: c?.opens ?? 0,
      sessions: c?.sessions ?? 0,
      activeInstalls: c?.activeInstalls ?? 0,
      events: c?.events ?? 0,
    };
  });
}

/**
 * The whole of the `/v1/summary` computation: resolve the range (validating and
 * clamping it), then count.
 *
 * `projectId` must already be authorized against the caller's key.
 */
export async function summary(
  db: D1Database,
  request: RangeRequest & { readonly now?: Date },
): Promise<{ range: ResolvedRange; rows: SummaryRow[] }> {
  const range = await resolveRange(db, request, request.now ?? new Date());
  return { range, rows: await summaryRows(db, range) };
}

// -----------------------------------------------------------------------------
// events/top — names
// -----------------------------------------------------------------------------

export interface TopEventRow {
  readonly name: string;
  readonly count: number;
  readonly installs: number;
}

/** Merged, ranked event-name totals for an already-resolved range. */
export async function topEventRows(
  db: D1Database,
  range: ResolvedRange,
  limit: number,
): Promise<TopEventRow[]> {
  const totals = new Map<string, { count: number; installs: number }>();

  const add = (name: string, count: number, installs: number) => {
    const cur = totals.get(name);
    if (cur === undefined) totals.set(name, { count, installs });
    else {
      cur.count += count;
      // Summing distinct counts across sources is the documented upper bound.
      cur.installs += installs;
    }
  };

  if (range.rawFrom !== null) {
    const { results } = await db
      .prepare(
        `SELECT name, COUNT(*) AS count, COUNT(DISTINCT install_id) AS installs
           FROM events
          WHERE project_id = ?1 AND day >= ?2 AND day <= ?3${debugClause(range.includeDebug)}
          GROUP BY name`,
      )
      .bind(range.projectId, range.rawFrom, range.to)
      .all<{ name: string; count: number; installs: number }>();
    for (const r of results) add(r.name, r.count, r.installs);
  }

  if (range.rollupTo !== null) {
    const { results } = await db
      .prepare(
        `SELECT name, SUM(count) AS count, SUM(installs) AS installs
           FROM daily_event_rollups
          WHERE project_id = ?1 AND include_debug = ?2 AND day >= ?3 AND day <= ?4
          GROUP BY name`,
      )
      .bind(range.projectId, range.includeDebug ? 1 : 0, range.from, range.rollupTo)
      .all<{ name: string; count: number; installs: number }>();
    for (const r of results) add(r.name, r.count, r.installs);
  }

  // §8.2: count descending, then `name` ascending in §0 byte order as a
  // deterministic tiebreak. Sorting in JS rather than SQL because the two
  // sources are merged first — an ORDER BY + LIMIT in either query alone could
  // drop a name that only ranks once the other source is added.
  return [...totals.entries()]
    .map(([name, v]) => ({ name, count: v.count, installs: v.installs }))
    .sort((a, b) => b.count - a.count || byteCompare(a.name, b.name))
    .slice(0, limit);
}

/**
 * The whole of the `/v1/events/top` computation with no `name`: resolve the
 * range, then rank event names.
 */
export async function topEvents(
  db: D1Database,
  request: RangeRequest & { readonly limit?: number; readonly now?: Date },
): Promise<{ range: ResolvedRange; rows: TopEventRow[] }> {
  const range = await resolveRange(db, request, request.now ?? new Date());
  return { range, rows: await topEventRows(db, range, request.limit ?? DEFAULT_LIMIT) };
}

// -----------------------------------------------------------------------------
// events/top — prop breakdown
// -----------------------------------------------------------------------------

export type PropValue = string | boolean | null;

export interface PropRow {
  prop: string;
  value: PropValue;
  count: number;
  installs: number;
}

/** The §8.2 prop breakdown for one event name, over an already-resolved range. */
export async function propBreakdownRows(
  db: D1Database,
  range: ResolvedRange,
  name: string,
  limit: number,
): Promise<PropRow[]> {
  // Keyed by prop + a type tag + the value, so the JSON string "true" and the
  // JSON boolean true stay separate rows (they are different prop values).
  const merged = new Map<string, PropRow>();
  const keyOf = (prop: string, value: PropValue) =>
    `${prop} ${value === null ? 'n' : typeof value === 'boolean' ? `b${value}` : `s${value}`}`;

  const add = (prop: string, value: PropValue, count: number, installs: number) => {
    const k = keyOf(prop, value);
    const cur = merged.get(k);
    if (cur === undefined) merged.set(k, { prop, value, count, installs });
    else {
      cur.count += count;
      cur.installs += installs;
    }
  };

  const propKeys = new Set<string>();

  if (range.rawFrom !== null) {
    // 1. Which props to break down. §8.2: only string, bool and null props;
    //    numeric props are omitted entirely (bucketing is unspecified in v1 and
    //    a raw breakdown of a continuous value is a cardinality hazard).
    const { results: keyRows } = await db
      .prepare(
        `SELECT j.key AS prop, COUNT(*) AS n
           FROM events e, json_each(e.props) j
          WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
            AND j.type IN ('text', 'true', 'false', 'null')
            ${range.includeDebug ? '' : 'AND e.is_debug = 0'}
          GROUP BY j.key
          ORDER BY n DESC, j.key ASC
          LIMIT ${MAX_BREAKDOWN_PROPS}`,
      )
      .bind(range.projectId, range.rawFrom, range.to, name)
      .all<{ prop: string; n: number }>();

    for (const r of keyRows) {
      // Re-validate before this key is ever concatenated into a JSON path
      // below. Keys are already constrained at ingest, so this can only fire on
      // rows written by something other than the ingest path — which is exactly
      // when an unvalidated key would matter.
      if (PROP_KEY_RE.test(r.prop)) propKeys.add(r.prop);
    }

    // 2. Present, non-null values. `j.type` is selected and grouped so a bool
    //    can be re-emitted as a JSON bool rather than as SQLite's 1/0.
    const { results: valueRows } = await db
      .prepare(
        `SELECT j.key AS prop, j.type AS type, j.value AS value,
                COUNT(*) AS count, COUNT(DISTINCT e.install_id) AS installs
           FROM events e, json_each(e.props) j
          WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
            AND j.type IN ('text', 'true', 'false')
            ${range.includeDebug ? '' : 'AND e.is_debug = 0'}
          GROUP BY j.key, j.type, j.value`,
      )
      .bind(range.projectId, range.rawFrom, range.to, name)
      .all<{ prop: string; type: string; value: unknown; count: number; installs: number }>();

    for (const r of valueRows) {
      if (!propKeys.has(r.prop)) continue; // outside the documented prop cap
      const value: PropValue =
        r.type === 'true' ? true : r.type === 'false' ? false : String(r.value);
      add(r.prop, value, r.count, r.installs);
    }

    // 3. The null row, per prop. §8.2 folds "present with JSON null" and
    //    "absent from the event entirely" into ONE row, because "the app did not
    //    report a section" is one thing to a reader. That means this cannot be
    //    derived by subtraction — `installs` is a distinct count, and distinct
    //    counts do not subtract — so it is its own query.
    const keys = [...propKeys];
    if (keys.length > 0) {
      const values = keys.map((_, i) => `(?${i + 5})`).join(', ');
      const { results: nullRows } = await db
        .prepare(
          `WITH k(prop) AS (VALUES ${values})
           SELECT k.prop AS prop, COUNT(*) AS count, COUNT(DISTINCT e.install_id) AS installs
             FROM events e JOIN k
            WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
              AND (e.props IS NULL
                   OR json_type(e.props, '$.' || k.prop) IS NULL
                   OR json_type(e.props, '$.' || k.prop) = 'null')
              ${range.includeDebug ? '' : 'AND e.is_debug = 0'}
            GROUP BY k.prop`,
        )
        .bind(range.projectId, range.rawFrom, range.to, name, ...keys)
        .all<{ prop: string; count: number; installs: number }>();

      for (const r of nullRows) add(r.prop, null, r.count, r.installs);
    }
  }

  if (range.rollupTo !== null) {
    const { results } = await db
      .prepare(
        // `"isNull"` MUST stay quoted: `ISNULL` is a postfix operator in SQLite,
        // so a bare `is_null AS isNull` is a syntax error, not an alias. It made
        // every `/v1/events/top?name=` request whose range reached past raw
        // retention answer 500 — and nothing exercised it, because the suite only
        // ever read `/v1/summary` past the boundary.
        `SELECT prop, value_type AS type, value, is_null AS "isNull",
                SUM(count) AS count, SUM(installs) AS installs
           FROM daily_prop_rollups
          WHERE project_id = ?1 AND include_debug = ?2 AND day >= ?3 AND day <= ?4 AND name = ?5
          GROUP BY prop, value_type, value_key, is_null`,
      )
      .bind(range.projectId, range.includeDebug ? 1 : 0, range.from, range.rollupTo, name)
      .all<{ prop: string; type: string; value: string | null; isNull: number; count: number; installs: number }>();

    for (const r of results) {
      if (!PROP_KEY_RE.test(r.prop)) continue;
      propKeys.add(r.prop);
      const value: PropValue =
        r.isNull === 1 ? null : r.type === 'true' ? true : r.type === 'false' ? false : String(r.value);
      add(r.prop, value, r.count, r.installs);
    }
  }

  // THE PROP CAP, applied ONCE over the merged result rather than per source.
  //
  // The raw branch has always had `LIMIT MAX_BREAKDOWN_PROPS` in SQL; the rollup
  // branch had no cap at all, so a range served from rollups could return an
  // unbounded number of props, and a MIXED range returned "raw's top 20, plus
  // every prop the rollups knew about" — a prop set that depended on which side of
  // the retention boundary the range happened to straddle, and that could exceed
  // the documented cap without ever saying so.
  //
  // Ranking here, on merged totals, makes the answer one thing: the 20 most
  // frequent props across the whole requested range, `prop` ascending as the
  // deterministic tiebreak §8.2 requires, whatever the range's sources are. The
  // SQL `LIMIT` stays as a cheap pre-filter on the raw side; it uses the same
  // criterion, so it cannot promote a prop this ranking would not have kept.
  const totalsByProp = new Map<string, number>();
  for (const row of merged.values()) {
    totalsByProp.set(row.prop, (totalsByProp.get(row.prop) ?? 0) + row.count);
  }
  const keptProps = new Set(
    [...totalsByProp.entries()]
      .sort((a, b) => b[1] - a[1] || byteCompare(a[0], b[0]))
      .slice(0, MAX_BREAKDOWN_PROPS)
      .map(([prop]) => prop),
  );

  // §8.2 ordering: grouped by `prop` (props ascending), and within each prop by
  // count descending, then value ascending, with the `null` row LAST regardless
  // of its count.
  const grouped = new Map<string, PropRow[]>();
  for (const row of merged.values()) {
    if (!keptProps.has(row.prop)) continue;
    const list = grouped.get(row.prop);
    if (list === undefined) grouped.set(row.prop, [row]);
    else list.push(row);
  }

  const out: PropRow[] = [];
  for (const prop of [...grouped.keys()].sort(byteCompare)) {
    const list = grouped.get(prop) as PropRow[];
    list.sort((a, b) => {
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (b.count !== a.count) return b.count - a.count;
      return byteCompare(String(a.value), String(b.value));
    });
    // §8.2: with `name`, `limit` caps rows PER PROP — so 5 props at limit=20
    // legitimately returns up to 100 rows.
    out.push(...list.slice(0, limit));
  }
  // Drop zero-count null rows: a prop whose null row is 0 events is not a fact
  // about the data, it is an artifact of asking.
  return out.filter((r) => r.count > 0);
}

/**
 * The whole of the `/v1/events/top?name=` computation: resolve the range, then
 * break the named event down by prop.
 */
export async function propBreakdown(
  db: D1Database,
  request: RangeRequest & { readonly name: string; readonly limit?: number; readonly now?: Date },
): Promise<{ range: ResolvedRange; rows: PropRow[] }> {
  const range = await resolveRange(db, request, request.now ?? new Date());
  return {
    range,
    rows: await propBreakdownRows(db, range, request.name, request.limit ?? DEFAULT_LIMIT),
  };
}
