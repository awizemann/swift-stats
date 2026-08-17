// POST /v1/events — schema §7.

import {
  badRequest,
  HttpError,
  json,
  payloadTooLarge,
  rateLimited,
} from './errors.js';
import { bucketDay } from './dates.js';
import { resolveKey } from './keys.js';
import { MAX_BODY_BYTES, parseJsonBody, validateBatch } from './validate.js';
import { logger } from './log.js';
import type { Env } from './env.js';

/**
 * Hard cap on the bytes we will read off the wire.
 *
 * §5 requires a backend that accepts gzip to cap the COMPRESSED body so a
 * compression bomb cannot exhaust it. This backend does not accept gzip at all
 * (see below), so the compressed and uncompressed caps coincide — but the cap
 * still has to exist, because `Content-Length` is a claim by the client and a
 * chunked request has none.
 */
const MAX_WIRE_BYTES = 2 * 1024 * 1024;

/**
 * Per-isolate best-effort limiter. Deliberately NOT the real rate limit — see
 * README "Rate limiting": the durable global limit is a Cloudflare Rate
 * Limiting rule in front of the Worker. This is a cheap backstop that costs no
 * storage read, and it is set high enough (§7: at most one request in flight per
 * client) that a conforming emitter cannot trip it.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 600;
const buckets = new Map<string, { count: number; resetAt: number }>();

function checkRate(projectId: string, now: number): void {
  const bucket = buckets.get(projectId);
  if (bucket === undefined || now >= bucket.resetAt) {
    buckets.set(projectId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_WINDOW) {
    throw rateLimited(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
  }
}

function checkContentType(header: string | null): void {
  if (header === null) {
    throw badRequest('bad_content_type', 'Content-Type must be application/json.');
  }
  // `application/json` optionally with parameters. Compare the media type only,
  // case-insensitively, so `Application/JSON; charset=UTF-8` is accepted.
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw badRequest('bad_content_type', 'Content-Type must be application/json.');
  }
}

function checkContentEncoding(header: string | null): void {
  if (header === null) return;
  const encoding = header.trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return;
  // §7: gzip support is optional and NOT discoverable at runtime, and a backend
  // that does not support it MUST reject a gzipped body with 400 rather than
  // silently mis-parse. This backend does not support it: an emitter defaults to
  // uncompressed, and the README says so, so the only way to get here is an
  // emitter explicitly configured against a README it did not read.
  throw badRequest(
    'unsupported_encoding',
    'This backend does not accept a compressed body. Send uncompressed JSON.',
  );
}

async function readBody(request: Request): Promise<string> {
  // Trust `Content-Length` only to REJECT early, never to accept — a client can
  // understate it, or omit it entirely on a chunked request.
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      throw payloadTooLarge(`Body exceeds the ${MAX_BODY_BYTES}-byte limit. Re-split the batch.`);
    }
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_WIRE_BYTES) {
    throw payloadTooLarge('Body exceeds the wire limit.');
  }
  // §5's limit is on UTF-8 BYTES of the serialized JSON, which is exactly
  // `byteLength` here — not the decoded string's length.
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw payloadTooLarge(`Body exceeds the ${MAX_BODY_BYTES}-byte limit. Re-split the batch.`);
  }
  // Non-fatal by default: invalid UTF-8 becomes U+FFFD rather than throwing, and
  // the resulting JSON.parse failure is a clean 400 (§0: the body is UTF-8 JSON
  // with no BOM, which TextDecoder strips for us anyway).
  return new TextDecoder().decode(buffer);
}

export async function handleIngest(request: Request, env: Env, now: Date): Promise<Response> {
  // Order is deliberate. Cheap header checks first, then auth, then the body:
  // an unauthenticated caller never gets us to read or parse a 256 KiB body.
  //
  // §7: `X-Stats-Read-Key` on this path is IGNORED — not 400, not 401 — because
  // both of those are permanent drops for the emitter. There is intentionally no
  // code here that looks at it.
  checkContentType(request.headers.get('content-type'));
  checkContentEncoding(request.headers.get('content-encoding'));

  const scope = await resolveKey(env.DB, request.headers.get('x-stats-key'), 'write');
  checkRate(scope.projectId, now.getTime());

  const batch = validateBatch(parseJsonBody(await readBody(request)));

  // §2.4: projectId is authoritative from the WRITE KEY. A client-asserted value
  // that disagrees is 400 — a permanent drop, so a misconfigured app fails
  // loudly instead of quietly writing into the wrong project. The derived value
  // is what gets stored; `batch.assertedProjectId` is never persisted.
  if (batch.assertedProjectId !== null && batch.assertedProjectId !== scope.projectId) {
    throw badRequest(
      'project_mismatch',
      'The `projectId` on the events disagrees with the write key\'s scope.',
    );
  }
  const projectId = scope.projectId;

  if (batch.propsAdjustments > 0) {
    // §2.3 adjustments degrade a property; they never fail the batch. Logged so
    // an emitter bug is visible. No prop key, value, or id is logged.
    logger.warn('props_adjusted', {
      projectId,
      adjustments: batch.propsAdjustments,
      events: batch.events.length,
    });
  }

  const receivedAt = now.toISOString();
  const c = batch.context;

  const statements: D1PreparedStatement[] = [];

  // §6 idempotency. This INSERT is the FIRST statement of the batch and
  // `(project_id, batch_id)` is the PRIMARY KEY, so a duplicate aborts the D1
  // batch atomically — events cannot be written twice, and there is no
  // read-then-write race to lose. (A pre-flight SELECT would have exactly that
  // race: two concurrent retries of the same batch would both see "absent".)
  statements.push(
    env.DB.prepare(
      `INSERT INTO batches (batch_id, project_id, received_at, event_count)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(batch.batchId, projectId, receivedAt, batch.events.length),
  );

  statements.push(
    env.DB.prepare(
      `INSERT INTO batch_context (
         batch_id, project_id, sent_at, sdk_version, app_version, app_build, bundle_id,
         os_name, os_version, device_model, arch, locale, region,
         screen_width, screen_height, screen_scale, is_debug, is_testflight, color_scheme
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
    ).bind(
      batch.batchId,
      projectId,
      batch.sentAt,
      c.sdkVersion,
      c.appVersion,
      c.appBuild,
      c.bundleId,
      c.osName,
      c.osVersion,
      c.deviceModel,
      c.arch,
      c.locale,
      c.region,
      c.screenWidth,
      c.screenHeight,
      c.screenScale,
      c.isDebug ? 1 : 0,
      c.isTestFlight ? 1 : 0,
      c.colorScheme,
    ),
  );

  const insertEvent = env.DB.prepare(
    `INSERT INTO events (
       project_id, batch_id, day, ts, name, session_id, install_id, app_id, seq, user_id, props, is_debug
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  );

  for (const e of batch.events) {
    statements.push(
      insertEvent.bind(
        projectId,
        batch.batchId,
        // §10: a future-dated or implausibly old `ts` is tolerated and clamped
        // into the retention window for AGGREGATION. `ts` itself is stored
        // verbatim on the next line.
        bucketDay(e.ts, now),
        e.ts,
        e.name,
        e.sessionId,
        e.installId,
        e.appId,
        e.seq,
        e.userId,
        e.props === null ? null : JSON.stringify(e.props),
        c.isDebug ? 1 : 0,
      ),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (cause) {
    // Distinguish "duplicate batch" from a real fault by ASKING THE DATABASE,
    // not by matching the driver's error string — a message change in D1 must
    // not silently turn duplicates into 500s (which the emitter would retry
    // forever) or faults into 202s (which would lose data).
    // Scoped to the project, matching the (project_id, batch_id) primary key —
    // another tenant's row must never be able to answer this question.
    const existing = await env.DB.prepare(
      `SELECT 1 AS ok FROM batches WHERE project_id = ?1 AND batch_id = ?2`,
    )
      .bind(projectId, batch.batchId)
      .first<{ ok: number }>();

    if (existing !== null) {
      // §6: a duplicate is a SUCCESS. 202, exactly as for a first delivery, so
      // the emitter deletes it from its queue instead of retrying forever.
      logger.info('batch_duplicate', { projectId, events: batch.events.length });
      return json({ accepted: batch.events.length, duplicate: true }, 202);
    }

    logger.error('ingest_failed', { projectId, events: batch.events.length }, cause);
    // §7: return 5xx and let the client retry rather than accepting-and-losing.
    throw new HttpError(503, 'internal_error', 'Storage unavailable. Retry with backoff.', {
      'retry-after': '5',
    });
  }

  // 202 only now: `db.batch()` has committed, so the batch would survive the
  // process dying (§7).
  return json({ accepted: batch.events.length }, 202);
}
