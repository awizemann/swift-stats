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
//     day >= boundary  ->  raw `events` rows      (exact distinct counts)
//     day <  boundary  ->  the daily rollup tables (see the caveat below)
//
// The boundary is where the retention sweep has actually left raw rows (see
// `rawBoundaryDay`), so the two sets are disjoint and complete. Preferring raw inside the window is what makes a late-arriving
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
  MIN_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
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
 * The 20 kept are the props most often PRESENT (non-null) on that event name in
 * the range — not counting the null row — `prop` ascending as a deterministic
 * tiebreak. See `propBreakdownRows`.
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
 * So the boundary is derived from observed state instead. The rule:
 *
 *     boundary = min(oldest raw day of this project, rawCutoffDay(now, MIN_RETENTION_DAYS))
 *
 * and, with no raw rows at all, just the second term. Why each half:
 *
 *  * `rawCutoffDay(now, MIN_RETENTION_DAYS)` (`today - 89`) is the newest day any
 *    sweep can EVER have deleted, under any retention setting past or present:
 *    windows are clamped to at least 90 days and the clock only moves forward.
 *    Every day at or above it has all the raw rows it ever had, so raw is the
 *    authoritative answer there — including a confident zero for a day a §13
 *    erasure emptied, where the day's stale rollup would be the wrong one. This
 *    is what keeps a new or quiet project (oldest raw row yesterday) from having
 *    its older days moved off the rollups.
 *  * Below that line, a day is read from raw only if it is at or above the
 *    project's oldest surviving raw row. Raw rows below `today - 89` are a
 *    SUFFIX of what the sweep left behind — it deletes `day < cutoff` per
 *    project, oldest first — so every day at or above the oldest row still has
 *    all of its rows, and below it there are none to double-count against.
 *
 * Deliberately NOT the project's own `retention_days` cutoff. That is a statement
 * about what the sweep WILL keep from now on, not about what it has already
 * removed, and the two differ exactly when it matters: raise a project from 90 to
 * 180 days and the clock-derived cutoff jumps back 90 days at once, while the raw
 * rows for those days were swept under the old window long ago. Routing them to
 * raw read every one of those 90 days as zero, with the rollups that hold their
 * history sitting right there. Observed rows cannot be wrong that way: a project
 * that really keeps 180 days has raw rows back to day 179, and its oldest row is
 * where the boundary lands.
 *
 * Both directions of the resulting boundary stay safe:
 *
 *  * No day above the boundary can be missing raw rows that a rollup would have
 *    covered (the two bullets above).
 *  * Below the boundary there are no raw rows at all, so the rollups cannot
 *    double-count with them.
 *
 * And never below `raw_complete_from` (0007). After a retention increase the
 * days between the new cutoff and that marker were swept under the old window:
 * a raw row there — a late batch written before ingest clamped to the marker, a
 * stray from an older Worker — is not that day's answer, and taken as the oldest
 * raw day it would also have dragged every day above it onto raw rows that do
 * not exist. The marker caps the boundary from below, so those days read from
 * their rollups whatever stray rows sit under them.
 *
 * One indexed `MIN(day)` on `events_scope` plus a primary-key lookup, in one
 * round trip.
 */
export async function rawBoundaryDay(
  db: D1Database,
  projectId: string,
  now: Date,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT (SELECT MIN(day) FROM events WHERE project_id = ?1) AS oldest,
              (SELECT raw_complete_from FROM projects WHERE id = ?1) AS marker`,
    )
    .bind(projectId)
    .first<{ oldest: string | null; marker: string | null }>();

  // A project row that is absent (deleted mid-request) needs no special case:
  // this function routes days, it does not authorize — a missing row is just a
  // NULL marker.
  const neverSwept = rawCutoffDay(now, MIN_RETENTION_DAYS);
  const oldest = row?.oldest ?? null;
  const observed = oldest !== null && oldest < neverSwept ? oldest : neverSwept;
  const marker = row?.marker ?? null;
  return marker !== null && marker > observed ? marker : observed;
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

  // Every breakdown-eligible prop seen in the range, from either source — the
  // CANDIDATES for the cap. Ranking happens once, below, over merged totals.
  const candidates = new Set<string>();

  if (range.rawFrom !== null) {
    // 1. Which props exist. §8.2: only string, bool and null props; numeric
    //    props are omitted entirely (bucketing is unspecified in v1 and a raw
    //    breakdown of a continuous value is a cardinality hazard). No `LIMIT`
    //    here: a per-source cap is how a mixed range used to drop a prop that
    //    only ranks once the other source is added.
    const { results: keyRows } = await db
      .prepare(
        `SELECT DISTINCT j.key AS prop
           FROM events e, json_each(e.props) j
          WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
            AND j.type IN ('text', 'true', 'false', 'null')
            ${range.includeDebug ? '' : 'AND e.is_debug = 0'}`,
      )
      .bind(range.projectId, range.rawFrom, range.to, name)
      .all<{ prop: string }>();

    for (const r of keyRows) {
      // Re-validate before this key is ever concatenated into a JSON path
      // below. Keys are already constrained at ingest, so this can only fire on
      // rows written by something other than the ingest path — which is exactly
      // when an unvalidated key would matter.
      if (PROP_KEY_RE.test(r.prop)) candidates.add(r.prop);
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
      if (!candidates.has(r.prop)) continue;
      const value: PropValue =
        r.type === 'true' ? true : r.type === 'false' ? false : String(r.value);
      add(r.prop, value, r.count, r.installs);
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
      candidates.add(r.prop);
      const value: PropValue =
        r.isNull === 1 ? null : r.type === 'true' ? true : r.type === 'false' ? false : String(r.value);
      add(r.prop, value, r.count, r.installs);
    }
  }

  // THE PROP CAP, applied ONCE over the merged result rather than per source, so
  // the answer is the 20 most frequent props across the whole requested range,
  // `prop` ascending as the deterministic tiebreak §8.2 requires, whatever the
  // range's sources are. (The rollup branch once had no cap at all, and the raw
  // branch a SQL `LIMIT` of its own, so a mixed range's prop set depended on
  // which side of the retention boundary the range happened to straddle.)
  //
  // "Most frequent" means how often the prop was PRESENT with a value: the sum of
  // its non-null rows. NOT including the null row. The null row counts events
  // that LACKED the prop, so value-plus-null is just "events of this name on the
  // days the prop appeared" — the same number for every prop reported on the
  // same days. Ranked that way, a prop on 40 of 60 events and a prop on 1 of them
  // tied, the tie fell to byte order, and the frequent prop could be the one
  // dropped. A prop seen only as an explicit JSON null ranks at 0: §8.2 folds
  // explicit null and absent into one row and the rollups store them folded, so
  // "present as null" is not separable from "absent" in every source.
  const presence = new Map<string, number>([...candidates].map((p) => [p, 0]));
  for (const row of merged.values()) {
    if (row.value !== null) presence.set(row.prop, (presence.get(row.prop) ?? 0) + row.count);
  }
  const keptProps = new Set(
    [...presence.entries()]
      .sort((a, b) => b[1] - a[1] || byteCompare(a[0], b[0]))
      .slice(0, MAX_BREAKDOWN_PROPS)
      .map(([prop]) => prop),
  );

  // 3. The raw null row, per KEPT prop — after the cap, so the statement binds at
  //    most MAX_BREAKDOWN_PROPS keys however many props the range has. §8.2 folds
  //    "present with JSON null" and "absent from the event entirely" into ONE
  //    row, because "the app did not report a section" is one thing to a reader.
  //    That means this cannot be derived by subtraction — `installs` is a
  //    distinct count, and distinct counts do not subtract — so it is its own
  //    query.
  //
  //    Counted only on days the prop was reported at least once (`dk`), which is
  //    the rule the rollup applies: it stores a day's null rows for the props
  //    seen THAT day. Deciding per range instead made one range answer two ways —
  //    a prop added mid-range had every event before it counted as "did not
  //    report" when the days were served raw, and none of them once the same days
  //    were served from rollups. Per day, a range's null row is the sum of its
  //    days' null rows from whichever store holds each day.
  const nullKeys = [...keptProps];
  if (range.rawFrom !== null && nullKeys.length > 0) {
    const values = nullKeys.map((_, i) => `(?${i + 5})`).join(', ');
    const debug = range.includeDebug ? '' : 'AND e.is_debug = 0';
    const { results: nullRows } = await db
      .prepare(
        `WITH k(prop) AS (VALUES ${values}),
         dk AS (
           SELECT DISTINCT e.day AS day, j.key AS prop
             FROM events e, json_each(e.props) j
            WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
              AND j.type IN ('text', 'true', 'false', 'null')
              AND j.key IN (SELECT prop FROM k)
              ${debug}
         )
         SELECT dk.prop AS prop, COUNT(*) AS count, COUNT(DISTINCT e.install_id) AS installs
           FROM events e JOIN dk ON dk.day = e.day
          WHERE e.project_id = ?1 AND e.day >= ?2 AND e.day <= ?3 AND e.name = ?4
            AND (e.props IS NULL
                 OR json_type(e.props, '$.' || dk.prop) IS NULL
                 OR json_type(e.props, '$.' || dk.prop) = 'null')
            ${debug}
          GROUP BY dk.prop`,
      )
      .bind(range.projectId, range.rawFrom, range.to, name, ...nullKeys)
      .all<{ prop: string; count: number; installs: number }>();

    for (const r of nullRows) add(r.prop, null, r.count, r.installs);
  }

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

// -----------------------------------------------------------------------------
// first-seen cohorts
// -----------------------------------------------------------------------------

export interface FirstSeenRow {
  /** UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  /** How many installs were seen for the FIRST time on that day. */
  readonly installs: number;
}

/**
 * Per-day counts of installs first seen in `[fromDay, toDay]` (table `installs`,
 * migration 0005).
 *
 * This is the whole of the read contract for that table, and it is deliberately
 * the only one: it returns COUNTS PER DAY, never an `install_id`. A consumer
 * building retention cohorts or a "new installs" chart gets what it needs, and
 * there is no function here it can call to get the ids — which is what keeps the
 * §13 story about this table true no matter which Worker imports the lib.
 *
 * Unlike `summaryRows` this needs no raw/rollup routing and no `now`: `installs`
 * is EXEMPT from the raw purge, so one row per install survives indefinitely and
 * there is exactly one source. It reaches back further than `/v1/summary` can
 * report activity for, which is the point of the table.
 *
 * Zero-filled over every day in the range, ascending, matching §8.1's rule for
 * `/v1/summary` — a consumer chart can trust the row count and never has to tell
 * "no data" from "missing row".
 *
 * Note what a count here is NOT: it is not "installs still active", and cohort
 * retention is this joined against `summary`-style activity, not derivable from
 * this alone.
 *
 * Throws `HttpError` (400) with the same `invalid_range` / `range_too_large`
 * codes and messages the public read endpoints use, so a consumer mapping this
 * onto its own transport reports failures identically. `projectId` must already
 * be authorized against the caller's key — as everywhere in this module, this
 * function does not authorize.
 */
export async function firstSeenRows(
  db: D1Database,
  projectId: string,
  fromDay: string,
  toDay: string,
): Promise<FirstSeenRow[]> {
  if (!isValidDate(fromDay) || !isValidDate(toDay)) {
    throw badRequest('invalid_range', '`from` and `to` must be real calendar days as YYYY-MM-DD.');
  }
  if (toDay < fromDay) {
    throw badRequest('invalid_range', '`to` must not be before `from`.');
  }
  // The same 400-day ceiling the read endpoints enforce (§8.1). There is no
  // clamp-to-today here: unlike an activity series, a future `to` on a cohort
  // query is harmless — no install can be first seen on a day that has not
  // happened, so those days zero-fill honestly rather than inventing a row.
  if (daysInclusive(fromDay, toDay) > MAX_RANGE_DAYS) {
    throw badRequest('range_too_large', `A range may span at most ${MAX_RANGE_DAYS} days.`);
  }

  const { results } = await db
    .prepare(
      // COUNT(*), not COUNT(DISTINCT install_id): (project_id, install_id) is the
      // primary key, so a row IS a distinct install and the distinct is free.
      // Served entirely by the `installs_first_seen` index.
      `SELECT first_seen_day AS day, COUNT(*) AS installs
         FROM installs
        WHERE project_id = ?1 AND first_seen_day >= ?2 AND first_seen_day <= ?3
        GROUP BY first_seen_day`,
    )
    .bind(projectId, fromDay, toDay)
    .all<{ day: string; installs: number }>();

  const byDay = new Map(results.map((r) => [r.day, r.installs]));
  return eachDay(fromDay, toDay).map((day) => ({ date: day, installs: byDay.get(day) ?? 0 }));
}

/**
 * How many installs this project has EVER been seen to have, first seen on or
 * before `throughDay` (default: all of them).
 *
 * The cumulative companion to `firstSeenRows`, kept here rather than left to a
 * consumer summing rows: a sum over a 400-day window is not the total, and a
 * consumer that computed it that way would silently report "total installs" as
 * "installs first seen in the last 400 days".
 */
export async function totalInstalls(
  db: D1Database,
  projectId: string,
  throughDay?: string,
): Promise<number> {
  if (throughDay !== undefined && !isValidDate(throughDay)) {
    throw badRequest('invalid_range', '`through` must be a real calendar day as YYYY-MM-DD.');
  }
  const row = await db
    .prepare(
      throughDay === undefined
        ? `SELECT COUNT(*) AS n FROM installs WHERE project_id = ?1`
        : `SELECT COUNT(*) AS n FROM installs WHERE project_id = ?1 AND first_seen_day <= ?2`,
    )
    .bind(...(throughDay === undefined ? [projectId] : [projectId, throughDay]))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The day at or below which `first_seen_day` values may be too recent — or
 * `null` when the `installs_backfill_day` marker row is absent.
 *
 * Migration 0005 backfilled `installs` from whatever raw `events` rows were still
 * present, as `MIN(day)` per install. For an install whose first event was still
 * inside the raw window that is exactly right. For an older one it is the oldest
 * SURVIVING day, which reads as "arrived on the retention boundary" — an install
 * that may have been first seen months or years earlier. The migration says so;
 * the DATA cannot, which is what this function is for: a cohort chart drawn
 * across the backfill would otherwise show a spike at that boundary that a
 * consumer has no way to tell from a real one.
 *
 * The floor is the raw boundary AS IT WAS on the day the backfill ran:
 * `rawCutoffDay(backfillDay, 90)`. Every install stored with `first_seen_day` at
 * or below it may have been first seen EARLIER; everything strictly above it is
 * exact.
 *
 * Deliberately NOT the project's CURRENT `retention_days`. The window in force
 * when 0005 ran is what decided how far back its `MIN(day)` could reach, and it
 * was 90 for every project: `retention_days` did not exist yet (0006 adds it,
 * with a default of 90, after 0005), so nothing could have kept raw rows longer.
 * Reading today's value instead moved the floor whenever retention changed
 * later — raise a project to 180 and the floor dropped 90 days below the
 * boundary spike, labelling the spike's installs exact. Nor `raw_complete_from`
 * (0007): it records later retention changes, which cannot have affected a
 * backfill that had already run.
 *
 * A FRESH deployment is NOT `null`. 0005 writes the marker unconditionally
 * (`date('now')`), including over an empty `events` table, so a database built
 * from scratch returns `markerDay − 89` like any other. That is harmless rather
 * than wrong: the backfill copied nothing, and under the default window ingest
 * clamps an old `ts` to `today − 89`, which is the floor on the marker day and
 * above it afterwards — so nothing lands below it, and at most a sighting
 * backdated on the marker day itself lands ON it and is labelled conservatively.
 * Only a project whose window is raised above 90 can store a (clamped, exact)
 * first sighting below the floor, and it errs the same safe way. An operator who
 * knows 0005 ran on an empty database may delete the marker row; deliberately
 * not done here by guessing from the data, which cannot tell a backfilled row
 * from an ingested one.
 *
 * `null` therefore means only "no marker row" (deleted by hand, or a schema that
 * predates it never re-run): read it as "all exact", never as "unknown".
 *
 * Cheap: one indexed point lookup. `projectId` is accepted for API stability and
 * so the floor can become per project again if a future migration ever makes the
 * backfill window differ by project; today it is the same for every project.
 */
export async function firstSeenFloorDay(
  db: D1Database,
  projectId: string,
): Promise<string | null> {
  void projectId;
  const row = await db
    .prepare(`SELECT value AS markerDay FROM backend_markers WHERE key = 'installs_backfill_day'`)
    .first<{ markerDay: string | null }>();

  const markerDay = row?.markerDay ?? null;
  // No marker: a deployment whose `installs` table was never backfilled over
  // existing events. Nothing to distrust.
  if (markerDay === null || !isValidDate(markerDay)) return null;

  // `rawCutoffDay` takes the clock as a `Date`; the marker is a UTC day, so
  // midnight UTC on that day is the instant the migration's `date('now')` named.
  return rawCutoffDay(new Date(`${markerDay}T00:00:00.000Z`), RAW_RETENTION_DAYS);
}
