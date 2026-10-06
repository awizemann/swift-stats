// POST /v1/users/erase — schema §8.4.
//
// The HTTP layer ONLY, the way `read.ts` is for reads: authenticate an admin
// key, parse a tiny JSON body, check the project against the key's scope, hand
// the rest to `eraseUserChunk` in `./lib/erase.js` (which the dashboard calls
// directly), and answer `{done, affected}`. What is erased, in what bounds, and
// why `installs` is left alone is all documented there.
//
// The check order (schema §8.4 lists it) follows §8's, for §8's reason:
//   1. header checks (400) — cheap, and they say nothing about any project,
//   2. the pre-auth rate limit (429), before any D1 read,
//   3. the key (401): an `admin` key, nothing else — a write or read key is the
//      same byte-identical 401 as an unknown one, because `kind` is part of
//      `resolveKey`'s lookup,
//   4. the body: size (413), JSON (400 `bad_json`), an object (400 `bad_request`),
//   5. `projectId` against the scope (401, never 400 — a malformed or foreign
//      project must look exactly like a nonexistent one),
//   6. `userId`, then `mode` (400).
// Validating `userId` before the scope would let an admin key for one project
// tell a 400 from a 401 for another, which is the probe §8 forbids.

import { badRequest, json, payloadTooLarge, unauthorized } from './errors.js';
import { checkContentEncoding, checkContentType } from './ingest.js';
import { requireScope, resolveKey, touchKey } from './keys.js';
import { checkPreAuthRate } from './ratelimit.js';
import { parseJsonBody } from './validate.js';
import { deferLog, logger } from './log.js';
import { eraseUserChunk, parseEraseMode, parseUserIdHash } from './lib/erase.js';
import { PROJECT_ID_RE } from './lib/queries.js';
import type { Env } from './env.js';

/**
 * The largest erase body we will read. The real one is under 200 bytes
 * (`projectId` ≤ 64, a 64-hex `userId`, a mode); 4 KiB leaves room for
 * whitespace and unknown keys (§0: ignored) without letting this path be used
 * to make the Worker buffer anything worth having.
 */
const MAX_ERASE_BODY_BYTES = 4_096;

/**
 * Read the body through a counting loop that stops at the cap — the same
 * pattern, for the same reason, as ingest's `readBody`: `request.text()` would
 * buffer whatever a client chose to send before we could say no. Not shared
 * with ingest because ingest's messages ("re-split the batch") and its two-tier
 * wire/body cap are about batches; this needs neither.
 */
async function readSmallBody(request: Request, ctx: ExecutionContext): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ERASE_BODY_BYTES) {
    throw payloadTooLarge(`Body exceeds the ${MAX_ERASE_BODY_BYTES}-byte limit.`);
  }
  const body = request.body;
  if (body === null) throw badRequest('bad_json', 'Body is not valid JSON.');

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_ERASE_BODY_BYTES) {
        ctx.waitUntil(reader.cancel().catch(() => {}));
        throw payloadTooLarge(`Body exceeds the ${MAX_ERASE_BODY_BYTES}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function handleEraseUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Date,
): Promise<Response> {
  checkContentType(request.headers.get('content-type'));
  checkContentEncoding(request.headers.get('content-encoding'));

  const presentedKey = request.headers.get('x-stats-admin-key');
  // Pre-auth, in its own `admin:` bucket, before the D1 read — see ratelimit.ts.
  await checkPreAuthRate(presentedKey, now.getTime(), 'admin');
  const scope = await resolveKey(env.DB, presentedKey, 'admin');
  // `last_used_at` (0004) for admin keys too: rotating one is the same
  // "is the old key still in use?" question.
  ctx.waitUntil(touchKey(env.DB, scope, now));

  const body = parseJsonBody(await readSmallBody(request, ctx));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('bad_request', 'Body must be a JSON object.');
  }
  const fields = body as Record<string, unknown>;

  const projectId = fields.projectId;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw unauthorized();
  requireScope(scope, projectId);

  // `userId` before `mode`: a request wrong in both ways answers about the id.
  const userIdHash = parseUserIdHash(fields.userId);
  const mode = parseEraseMode(fields.mode);

  const result = await eraseUserChunk(env.DB, projectId, userIdHash, mode);

  // Counts and the mode only — never the `userId` hash. It is a person-scale
  // identifier, and an erase is exactly the request whose subject must not
  // reappear in a log with a different retention story (§13).
  deferLog(ctx, () =>
    logger.info('user_erase', { projectId, mode, rows: result.affected, done: result.done }),
  );
  return json({ done: result.done, affected: result.affected }, 200);
}
