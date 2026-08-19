// GET /v1/summary and GET /v1/events/top — schema §8.
//
// This file is the HTTP layer ONLY: authenticate, pull parameters off the query
// string, hand them to `lib/queries.ts`, wrap the result in the §8 response
// envelope. Every computation — the raw/rollup day routing, the counts, the
// prop cap, the sort orders, the date validation and clamping — lives in
// `./lib/queries.js`, so the swiftstats.co dashboard Worker (same D1, different
// deployment) can import the same functions and cannot report a different
// number than this endpoint does. See README §11.
//
// Both endpoints are safe and idempotent: nothing in this file writes.

import { json, unauthorized } from './errors.js';
import { requireScope, resolveKey, type KeyScope } from './keys.js';
import { checkPreAuthRate, READ_LIMIT_PER_WINDOW } from './ratelimit.js';
import { SCHEMA_VERSION } from './validate.js';
import { logger } from './log.js';
import type { Env } from './env.js';
import {
  clampAndValidateDays,
  parseEventName,
  parseIncludeDebug,
  parseLimit,
  propBreakdownRows,
  PROJECT_ID_RE,
  rangeSource,
  requireBothDays,
  resolveRange,
  summaryRows,
  topEventRows,
  type ResolvedRange,
} from './lib/queries.js';

export { MAX_BREAKDOWN_PROPS } from './lib/queries.js';

/**
 * Authorize, then parse, then resolve the range.
 *
 * The check order is load-bearing:
 *   1. key -> scope (401),
 *   2. projectId against the scope (401),
 *   3. dates (400).
 * Doing dates first would let an unauthenticated caller distinguish a 400 from a
 * 401 and so probe which projects exist — the thing §8 forbids. `resolveRange`
 * is therefore only reached once the key is known to cover the project it names.
 */
async function readRange(url: URL, env: Env, scope: KeyScope, now: Date): Promise<ResolvedRange> {
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || !PROJECT_ID_RE.test(projectId)) {
    // A malformed projectId is a 401, not a 400. It cannot be in the key's
    // scope (the scope was minted through the same pattern), and answering 400
    // here would tell a caller that its 401s came from scope rather than syntax.
    throw unauthorized();
  }
  requireScope(scope, projectId);

  // Dates before `includeDebug`, matching §8's fixed order: a request that is
  // wrong in both ways answers `invalid_range`, not `bad_request`.
  const requested = requireBothDays(url.searchParams.get('from'), url.searchParams.get('to'));
  clampAndValidateDays(requested.from, requested.to, now);

  const includeDebug = parseIncludeDebug(url.searchParams.get('includeDebug'));

  return await resolveRange(env.DB, { ...requested, projectId, includeDebug }, now);
}

/** The §8 response envelope fields both read endpoints share. */
function envelope(range: ResolvedRange) {
  // §8.1: `from`/`to` echo what was actually SERVED, which may differ from what
  // was asked (a clamped `to`).
  return {
    schema: SCHEMA_VERSION,
    projectId: range.projectId,
    from: range.from,
    to: range.to,
    includeDebug: range.includeDebug,
  };
}

// -----------------------------------------------------------------------------
// GET /v1/summary
// -----------------------------------------------------------------------------

export async function handleSummary(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const presentedKey = request.headers.get('x-stats-read-key');
  // Pre-auth, keyed on SHA-256 of the presented key, never the IP (§13). §8.3
  // documents a 429 with `Retry-After` on the read endpoints; without a limiter
  // here there was no code path that could ever emit one.
  //
  // The READ ceiling, not the ingest one: a read key is one dashboard, while an
  // ingest key is a whole fleet, so the two cannot share a number. See
  // `ratelimit.ts` — and note that the limiter is per-isolate and advisory.
  await checkPreAuthRate(presentedKey, now.getTime(), READ_LIMIT_PER_WINDOW);
  const scope = await resolveKey(env.DB, presentedKey, 'read');
  const range = await readRange(url, env, scope, now);

  const rows = await summaryRows(env.DB, range);

  logger.info('summary', {
    projectId: range.projectId,
    rows: rows.length,
    source: rangeSource(range),
  });

  return json({ ...envelope(range), rows });
}

// -----------------------------------------------------------------------------
// GET /v1/events/top
// -----------------------------------------------------------------------------

export async function handleTopEvents(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const presentedKey = request.headers.get('x-stats-read-key');
  await checkPreAuthRate(presentedKey, now.getTime(), READ_LIMIT_PER_WINDOW);
  const scope = await resolveKey(env.DB, presentedKey, 'read');
  const range = await readRange(url, env, scope, now);
  const limit = parseLimit(url.searchParams.get('limit'));

  const name = parseEventName(url.searchParams.get('name'));

  const rows =
    name === null
      ? await topEventRows(env.DB, range, limit)
      : await propBreakdownRows(env.DB, range, name, limit);

  logger.info('events_top', { projectId: range.projectId, rows: rows.length });

  return json({ ...envelope(range), name, limit, rows });
}
