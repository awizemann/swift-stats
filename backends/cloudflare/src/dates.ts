// UTC calendar-day arithmetic. Everything in this backend buckets by the UTC
// day of the event `ts` (schema §8.1) — never `sentAt`, never a local day, and
// never anything that consults the host timezone.
//
// All functions here take and return `YYYY-MM-DD` strings, which sort
// lexicographically in the same order they sort chronologically. That property
// is why the SQL uses plain string comparison on `events.day`.

/** Raw retention for raw event rows, in days (schema §13, README "Retention"). */
export const RAW_RETENTION_DAYS = 90;

/** Maximum span a read request may ask for, inclusive of both ends (§8.1). */
export const MAX_RANGE_DAYS = 400;

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
 */
export function rawCutoffDay(now: Date): string {
  return addDays(today(now), -(RAW_RETENTION_DAYS - 1));
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
export function bucketDay(ts: string, now: Date): string {
  const day = ts.slice(0, 10);
  const max = today(now);
  if (day > max) return max;
  const min = rawCutoffDay(now);
  if (day < min) return min;
  return day;
}
