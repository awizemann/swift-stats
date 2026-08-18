// Structured logging with a hard privacy boundary.
//
// Schema §7 forbids echoing the request body in an error response, and §13
// forbids storing or logging the client IP, any derived geography, and any
// identifier of the backend's own invention. The rule this module enforces is
// stricter and easier to hold: NOTHING person-scale is ever logged. No
// `installId`, no `sessionId`, no `userId`, no prop key or value, no key or key
// hash, no request body, no IP.
//
// What is safe, and all that is permitted, is the `Fields` type below: the
// project, counts, and shapes. If you find yourself wanting to widen it to debug
// something, add a `projectId`-scoped counter instead.

export interface Fields {
  readonly projectId?: string;
  readonly day?: string;
  readonly events?: number;
  readonly rows?: number;
  readonly adjustments?: number;
  readonly duplicate?: boolean;
  readonly durationMs?: number;
  readonly status?: number;
  readonly path?: string;
  readonly source?: 'raw' | 'rollup' | 'mixed';
}

/**
 * Stable classification codes for a caught error. The log carries one of these,
 * never the driver's message text. Adding a code is fine; renaming one breaks
 * anything alerting on the logs.
 */
export type ErrorClass =
  | 'constraint_violation'
  | 'datatype_mismatch'
  | 'value_too_large'
  | 'no_such_table'
  | 'syntax_error'
  | 'timeout'
  | 'network'
  | 'non_error_thrown'
  | 'unclassified';

/**
 * Map an error to a fixed code.
 *
 * Logging `cause.message` verbatim was the hole this closes. SQLite constraint
 * messages already name the table and column, and a D1 or driver change can widen
 * them to include the BOUND PARAMETER VALUE — which on the ingest path is an
 * `installId`, a hashed `userId`, or a prop value. This module's rule is that
 * nothing person-scale is ever logged (§13), and a rule that holds only as long as
 * a dependency's message format does not change is not a rule.
 *
 * The trade is real and accepted: a genuinely novel fault logs as `unclassified`
 * with no detail. That is the right side to err on for a backend whose privacy
 * claims are the product, and the `event` name plus the surrounding fields
 * (project, counts, day) already localize a fault to one code path.
 */
export function classifyError(cause: unknown): ErrorClass {
  if (!(cause instanceof Error)) return 'non_error_thrown';
  const message = cause.message;
  if (/no such table|no such column/i.test(message)) return 'no_such_table';
  if (/datatype mismatch|cannot store .* value/i.test(message)) return 'datatype_mismatch';
  if (/string or blob too big|too large|out of range/i.test(message)) return 'value_too_large';
  if (/constraint failed|UNIQUE constraint|NOT NULL constraint|CHECK constraint/i.test(message)) {
    return 'constraint_violation';
  }
  if (/syntax error|malformed/i.test(message)) return 'syntax_error';
  if (/timed out|timeout|exceeded/i.test(message)) return 'timeout';
  if (/network|connection|fetch failed|socket/i.test(message)) return 'network';
  return 'unclassified';
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields, cause?: unknown): void {
  const line: Record<string, unknown> = { level, event, ...fields };
  if (cause !== undefined) {
    // A fixed code, never the driver's message — see `classifyError`.
    line.error = classifyError(cause);
  }
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  info: (event: string, fields: Fields = {}) => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}) => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}, cause?: unknown) => emit('error', event, fields, cause),
};
