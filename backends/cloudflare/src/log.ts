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

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields, cause?: unknown): void {
  const line: Record<string, unknown> = { level, event, ...fields };
  if (cause !== undefined) {
    // The message only — never a body, and never a bound parameter value, both
    // of which a driver may include in a stringified error object.
    line.error = cause instanceof Error ? cause.message : 'non-error thrown';
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
