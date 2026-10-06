// The reusable read layer — the package's `./lib` entry point.
//
// This is what a sibling Worker bound to the same D1 database imports. It is
// deliberately narrow: the query functions, the UTC day arithmetic they are
// defined in terms of, the one-user erase, and the error type they throw.
// Nothing here touches `Request`, `Response`, the router, or the Worker's `Env`.
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
  rawFloorDay,
  today,
} from '../dates.js';

// The one sanctioned way to change a project's retention window (0007): it moves
// `raw_complete_from` in the same statement. A dashboard that offers a
// retention setting must call this rather than UPDATE the column itself.
export { setProjectRetention } from '../retention.js';

// Erasing one user's events (§8.4, `POST /v1/users/erase`). The dashboard calls
// `eraseUserChunk` directly against D1, after its own ownership check, so an
// erase from the dashboard and one through the admin endpoint run the same
// statements and stop at the same bounds.
export {
  ERASE_CHUNK_ROWS,
  ERASE_MODES,
  erasedUserModes,
  ERASURE_TOMBSTONE_MARGIN_DAYS,
  eraseUserChunk,
  MAX_ERASE_CHUNKS,
  parseEraseMode,
  parseUserIdHash,
  purgeExpiredErasures,
  USER_ID_HASH_RE,
} from './erase.js';
export type { EraseMode, EraseOptions, EraseResult } from './erase.js';

// So a consumer can catch a validation failure and map it onto its own
// transport, with the same stable `code` and the same `message` the public API
// would have returned.
export { HttpError } from '../errors.js';
export type { ErrorCode } from '../errors.js';
