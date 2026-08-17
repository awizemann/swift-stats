// Consistent JSON error bodies (schema §8.3):
//     {"error": "<stable_snake_case>", "message": "<human text>"}
//
// Two rules this module exists to enforce mechanically:
//
//  1. The request body is NEVER echoed (§7). `message` is written by us, from
//     literals and validated field names only — never from a value on the wire.
//  2. `error` codes are stable snake_case. They are part of the backend's
//     public surface: a reader may branch on them, so renaming one is a
//     breaking change.

/** Stable machine codes. Adding is fine; renaming or removing is breaking. */
export type ErrorCode =
  // 400
  | 'bad_request'
  | 'bad_json'
  | 'bad_content_type'
  | 'unsupported_encoding'
  | 'bad_schema_version'
  | 'invalid_envelope'
  | 'invalid_event'
  | 'invalid_context'
  | 'reserved_event_name'
  | 'mixed_batch'
  | 'project_mismatch'
  | 'too_many_events'
  | 'empty_events'
  | 'invalid_range'
  | 'range_too_large'
  | 'invalid_limit'
  // 401
  | 'unauthorized'
  // 404 / 405
  | 'not_found'
  | 'method_not_allowed'
  // 413
  | 'payload_too_large'
  // 429
  | 'rate_limited'
  // 5xx
  | 'internal_error';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra response headers, e.g. `Retry-After` on a 429 (§7). */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toResponse(): Response {
    return new Response(JSON.stringify({ error: this.code, message: this.message }), {
      status: this.status,
      headers: { ...JSON_HEADERS, ...this.headers },
    });
  }
}

export const badRequest = (code: ErrorCode, message: string) => new HttpError(400, code, message);

/**
 * 401 for every authentication and authorization outcome.
 *
 * Deliberately one message for all of them. §8 requires that an out-of-scope
 * project be indistinguishable from a nonexistent one, and the cheapest way to
 * guarantee that is to have exactly one 401 constructor with a fixed string —
 * so "missing key", "revoked key", "wrong kind of key", "project you may not
 * see" and "project that does not exist" are byte-identical responses.
 */
export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'Missing, invalid, or out-of-scope key.');

export const payloadTooLarge = (message: string) => new HttpError(413, 'payload_too_large', message);

export const rateLimited = (retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', 'Too many requests.', {
    'retry-after': String(retryAfterSeconds),
  });

export const notFound = () => new HttpError(404, 'not_found', 'Unknown path.');

export const methodNotAllowed = (allow: string) =>
  new HttpError(405, 'method_not_allowed', 'Method not allowed for this path.', { allow });

export const internalError = () =>
  new HttpError(500, 'internal_error', 'Internal error. Retry with backoff.');

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
