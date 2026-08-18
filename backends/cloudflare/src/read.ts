// GET /v1/summary and GET /v1/events/top — schema §8.
//
// Both endpoints are safe and idempotent: nothing in this file writes.
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
// `installs` are EXACT for every `/v1/summary` row and for any `/v1/events/top`
// range that lies wholly inside raw retention. A per-day rollup row stores a
// per-day distinct count, and distinct counts are not additive — so
// `/v1/events/top`'s `installs`, which is a distinct count over the whole range,
// becomes an UPPER BOUND once the range reaches back past raw retention.
// `/v1/summary` is unaffected: its rows are per-day, which is the granularity
// the rollups store.

import { badRequest, json, unauthorized } from './errors.js';
import {
  eachDay,
  daysInclusive,
  isValidDate,
  MAX_RANGE_DAYS,
  rawCutoffDay,
  today,
  addDays,
} from './dates.js';
import { requireScope, resolveKey, type KeyScope } from './keys.js';
import { checkPreAuthRate } from './ratelimit.js';
import { SCHEMA_VERSION } from './validate.js';
import { logger } from './log.js';
import type { Env } from './env.js';

const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PROP_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Cap on how many distinct `prop` keys one `/v1/events/top?name=` response will
 * break down. §8.2 permits a cap and requires it be documented; the README
 * states this number. The 20 kept are the most frequent props for that event
 * name in the range, `prop` ascending as a deterministic tiebreak.
 */
export const MAX_BREAKDOWN_PROPS = 20;

interface Range {
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
 * Parse and authorize the parameters common to both read endpoints.
 *
 * The check order is load-bearing:
 *   1. key -> scope (401),
 *   2. projectId against the scope (401),
 *   3. dates.
 * Doing dates first would let an unauthenticated caller distinguish a 400 from a
 * 401 and so probe which projects exist — the thing §8 forbids.
 */
function parseRange(url: URL, scope: KeyScope, rawFromDay: string, now: Date): Range {
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || !PROJECT_ID_RE.test(projectId)) {
    // A malformed projectId is a 401, not a 400. It cannot be in the key's
    // scope (the scope was minted through the same pattern), and answering 400
    // here would tell a caller that its 401s came from scope rather than syntax.
    throw unauthorized();
  }
  requireScope(scope, projectId);

  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  if (fromRaw === null || toRaw === null) {
    throw badRequest('invalid_range', 'Both `from` and `to` are required (YYYY-MM-DD, UTC).');
  }
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

  const debugParam = url.searchParams.get('includeDebug');
  let includeDebug = false;
  if (debugParam !== null) {
    if (debugParam !== 'true' && debugParam !== 'false') {
      throw badRequest('bad_request', '`includeDebug` must be `true` or `false`.');
    }
    includeDebug = debugParam === 'true';
  }

  // `rawFromDay` is the OBSERVED boundary (see `rawBoundaryDay`), not the clock's
  // — every day at or above it is answered from raw rows, every day below it from
  // the rollups, and the two sets stay disjoint and complete.
  return {
    projectId,
    from,
    to,
    includeDebug,
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
async function rawBoundaryDay(env: Env, projectId: string, now: Date): Promise<string> {
  const cutoff = rawCutoffDay(now);
  const row = await env.DB.prepare(
    `SELECT MIN(day) AS oldest FROM events WHERE project_id = ?1`,
  )
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
 * Authorize, then parse, then resolve the raw/rollup boundary.
 *
 * `resolveKey` and `requireScope` still run before anything else — an
 * unauthenticated caller must not be able to tell a 400 from a 401 and so probe
 * which projects exist (§8) — and the boundary query runs only once the key is
 * known to cover the project it names.
 */
async function resolveRange(url: URL, env: Env, scope: KeyScope, now: Date): Promise<Range> {
  // A first pass with the clock's cutoff, purely to get the validated projectId
  // and the 400s out of the way in the order §8 fixes. Its `rawFrom`/`rollupTo`
  // are discarded.
  const validated = parseRange(url, scope, rawCutoffDay(now), now);
  const boundary = await rawBoundaryDay(env, validated.projectId, now);
  return parseRange(url, scope, boundary, now);
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
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

/** `AND is_debug = 0` unless the caller asked for debug traffic (§8.1 default). */
function debugClause(includeDebug: boolean): string {
  return includeDebug ? '' : ' AND is_debug = 0';
}

// -----------------------------------------------------------------------------
// GET /v1/summary
// -----------------------------------------------------------------------------

interface SummaryCounts {
  opens: number;
  sessions: number;
  activeInstalls: number;
  events: number;
}

export async function handleSummary(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const presentedKey = request.headers.get('x-stats-read-key');
  // Pre-auth, keyed on SHA-256 of the presented key, never the IP (§13). §8.3
  // documents a 429 with `Retry-After` on the read endpoints; without a limiter
  // here there was no code path that could ever emit one.
  await checkPreAuthRate(presentedKey, now.getTime());
  const scope = await resolveKey(env.DB, presentedKey, 'read');
  const range = await resolveRange(url, env, scope, now);

  const byDay = new Map<string, SummaryCounts>();

  if (range.rawFrom !== null) {
    const { results } = await env.DB.prepare(
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
    const { results } = await env.DB.prepare(
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

  // §8.1: a row for EVERY day in the served range, ascending, zero-filled where
  // there is no data — so a consumer chart can trust the row count and never has
  // to tell "no data" from "missing row". `eachDay` is the only thing that
  // decides the row set; the queries above only fill it in.
  const rows = eachDay(range.from, range.to).map((day) => {
    const c = byDay.get(day);
    return {
      date: day,
      opens: c?.opens ?? 0,
      sessions: c?.sessions ?? 0,
      activeInstalls: c?.activeInstalls ?? 0,
      events: c?.events ?? 0,
    };
  });

  logger.info('summary', {
    projectId: range.projectId,
    rows: rows.length,
    source: range.rawFrom !== null && range.rollupTo !== null ? 'mixed' : range.rawFrom !== null ? 'raw' : 'rollup',
  });

  // §8.1: `from`/`to` echo what was actually SERVED, which may differ from what
  // was asked (a clamped `to`).
  return json({
    schema: SCHEMA_VERSION,
    projectId: range.projectId,
    from: range.from,
    to: range.to,
    includeDebug: range.includeDebug,
    rows,
  });
}

// -----------------------------------------------------------------------------
// GET /v1/events/top
// -----------------------------------------------------------------------------

type PropValue = string | boolean | null;

interface PropRow {
  prop: string;
  value: PropValue;
  count: number;
  installs: number;
}

/** Byte-wise ascending over UTF-8 (§0). */
const byteCompare = (() => {
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

async function topNames(env: Env, range: Range, limit: number) {
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
    const { results } = await env.DB.prepare(
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
    const { results } = await env.DB.prepare(
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

async function breakdown(env: Env, range: Range, name: string, limit: number) {
  // Keyed by prop + a type tag + the value, so the JSON string "true" and the
  // JSON boolean true stay separate rows (they are different prop values).
  const merged = new Map<string, PropRow>();
  const keyOf = (prop: string, value: PropValue) =>
    `${prop} ${value === null ? 'n' : typeof value === 'boolean' ? `b${value}` : `s${value}`}`;

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
    const { results: keyRows } = await env.DB.prepare(
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
    const { results: valueRows } = await env.DB.prepare(
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
      const { results: nullRows } = await env.DB.prepare(
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
    const { results } = await env.DB.prepare(
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

export async function handleTopEvents(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const presentedKey = request.headers.get('x-stats-read-key');
  await checkPreAuthRate(presentedKey, now.getTime());
  const scope = await resolveKey(env.DB, presentedKey, 'read');
  const range = await resolveRange(url, env, scope, now);
  const limit = parseLimit(url);

  const nameParam = url.searchParams.get('name');
  if (nameParam !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(nameParam)) {
    // A syntactically invalid name is a malformed parameter -> 400. A
    // well-formed but unknown name is 200 with empty rows (§8.2), which falls
    // out of the queries naturally.
    throw badRequest('bad_request', '`name` must match ^[a-z][a-z0-9_]*$.');
  }

  const rows =
    nameParam === null
      ? await topNames(env, range, limit)
      : await breakdown(env, range, nameParam, limit);

  logger.info('events_top', { projectId: range.projectId, rows: rows.length });

  return json({
    schema: SCHEMA_VERSION,
    projectId: range.projectId,
    from: range.from,
    to: range.to,
    includeDebug: range.includeDebug,
    name: nameParam,
    limit,
    rows,
  });
}
