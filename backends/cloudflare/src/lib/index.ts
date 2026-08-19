// The reusable read layer — the package's `./lib` entry point.
//
// This is what a sibling Worker bound to the same D1 database imports. It is
// deliberately narrow: the query functions, the UTC day arithmetic they are
// defined in terms of, and the error type they throw. Nothing here touches
// `Request`, `Response`, the router, or the Worker's `Env`.
//
// See README §11, "Reusing the query layer".

export * from './queries.js';

// The day arithmetic the range contract is defined in terms of. A consumer
// building a "last 30 days" range must use the same UTC-day rules the queries
// bucket by (§8.1) — anything that consults a local timezone is a bug.
export {
  addDays,
  bucketDay,
  clampRetentionDays,
  daysInclusive,
  eachDay,
  isValidDate,
  isValidTimestamp,
  MAX_RANGE_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
  rawCutoffDay,
  today,
} from '../dates.js';

// So a consumer can catch a validation failure and map it onto its own
// transport, with the same stable `code` and the same `message` the public API
// would have returned.
export { HttpError } from '../errors.js';
export type { ErrorCode } from '../errors.js';
