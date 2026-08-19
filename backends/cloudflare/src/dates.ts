// UTC calendar-day arithmetic. Everything in this backend buckets by the UTC
// day of the event `ts` (schema §8.1) — never `sentAt`, never a local day, and
// never anything that consults the host timezone.
//
// All functions here take and return `YYYY-MM-DD` strings, which sort
// lexicographically in the same order they sort chronologically. That property
// is why the SQL uses plain string comparison on `events.day`.

/**
 * Default raw retention for raw event rows, in days (schema §13, README
 * "Retention").
 *
 * The DEFAULT, since 0006: a project may set its own `projects.retention_days`.
 * This is the value used for a project that has not, for a caller that has no
 * project in hand, and as the documented minimum.
 */
export const RAW_RETENTION_DAYS = 90;

/** Maximum span a read request may ask for, inclusive of both ends (§8.1). */
export const MAX_RANGE_DAYS = 400;

/**
 * The bounds a per-project retention window may take.
 *
 * The minimum is the documented 90 (see migration 0006: a shorter window does not
 * save storage so much as delete history the read layer would still have served).
 * The maximum is `MAX_RANGE_DAYS`, because a read may span at most that many days
 * — raw rows kept beyond it could never be reached as raw rows, only billed.
 */
export const MIN_RETENTION_DAYS = RAW_RETENTION_DAYS;
export const MAX_RETENTION_DAYS = MAX_RANGE_DAYS;

/**
 * A stored `projects.retention_days` folded into the supported range.
 *
 * Applied on every read of the column rather than enforced as a CHECK constraint
 * (0006 explains why), so a NULL from an older row, a non-integer, or a
 * hand-edited absurdity all degrade to the 90-day default instead of becoming a
 * mass delete.
 */
export function clampRetentionDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return RAW_RETENTION_DAYS;
  const days = Math.floor(n);
  if (days < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (days > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return days;
}

const DAY_MS = 86_400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True for a syntactically well-formed `YYYY-MM-DD` that also names a real
 * calendar day. The round-trip check is what rejects `2026-02-30`, which the
 * regex alone accepts and `Date.parse` silently rolls over to March 2nd.
 */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s;
}

/**
 * True for a timestamp in exactly the §0 form: ISO 8601, UTC, millisecond
 * precision, literal `Z`. A local offset (`+02:00`), second precision, or
 * microseconds are all rejected — §0 says a backend MUST reject any other form.
 */
export function isValidTimestamp(s: string): boolean {
  if (!TS_RE.test(s)) return false;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return false;
  // Guards `2026-13-01T…` and `…T25:00:00.000Z`, which the regex allows and
  // Date.parse (in V8) rejects or rolls over inconsistently across forms.
  return new Date(ms).toISOString() === s;
}

/** The UTC calendar day containing `now`. */
export function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `day` shifted by `delta` whole UTC days. Negative `delta` goes backwards. */
export function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, inclusive of both ends. `from === to` is 1. */
export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((b - a) / DAY_MS) + 1;
}

/** Every UTC day from `from` to `to` inclusive, ascending. Empty if `to < from`. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  if (to < from) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The oldest day for which raw event rows are guaranteed to still exist.
 *
 * The retention job deletes `day < cutoff`, so `cutoff` itself is the oldest
 * surviving day and reads may use raw rows for `day >= cutoff`. Off-by-one
 * matters here in both directions: one day too high silently answers a day
 * from rollups that also has raw rows (harmless but inconsistent), one day too
 * low reads a day whose rows the last sweep already removed and reports zeros.
 *
 * `retentionDays` is the PROJECT's window (0006). Every caller that has a project
 * in hand must pass it — the sweep deletes per project now, so a boundary derived
 * from the global default is only correct for a project that kept the default.
 */
export function rawCutoffDay(now: Date, retentionDays: number = RAW_RETENTION_DAYS): string {
  return addDays(today(now), -(clampRetentionDays(retentionDays) - 1));
}

/**
 * The UTC day an event is aggregated under.
 *
 * `ts` is stored verbatim, but §10 requires tolerating a future-dated or
 * implausibly old `ts` and SHOULD clamp it into the retention window for
 * aggregation. Clamping (rather than dropping, or trusting) means a device with
 * a wrong clock can neither create rows the retention sweep would never reach
 * nor land counts in a future row that §8.1 promises never appears.
 */
export function bucketDay(
  ts: string,
  now: Date,
  retentionDays: number = RAW_RETENTION_DAYS,
): string {
  const day = ts.slice(0, 10);
  const max = today(now);
  if (day > max) return max;
  // The project's own window (0006): clamping an ancient `ts` onto the global
  // 90-day boundary for a project that keeps 180 would land it on a day that
  // project's sweep will not delete for another 90 days, and would report it as
  // activity on a day it did not happen.
  const min = rawCutoffDay(now, retentionDays);
  if (day < min) return min;
  return day;
}
