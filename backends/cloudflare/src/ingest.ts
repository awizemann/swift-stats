// POST /v1/events — schema §7.

import { badRequest, HttpError, json, payloadTooLarge } from './errors.js';
import { bucketDay } from './dates.js';
import { resolveKey, touchKey } from './keys.js';
import { checkPreAuthRate, checkProjectRate } from './ratelimit.js';
import { MAX_BODY_BYTES, parseJsonBody, validateBatch } from './validate.js';
import { deferLog, logger } from './log.js';
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

async function readBody(request: Request, ctx: ExecutionContext): Promise<string> {
  // Trust `Content-Length` only to REJECT early, never to accept — a client can
  // understate it, or omit it entirely on a chunked request.
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      throw payloadTooLarge(`Body exceeds the ${MAX_BODY_BYTES}-byte limit. Re-split the batch.`);
    }
  }

  // Read through a COUNTING loop that aborts at the wire cap, rather than
  // `await request.arrayBuffer()` followed by a length check.
  //
  // The old order buffered the whole body first and only then compared its size,
  // which means the cap bounded what we *kept*, not what we *read*: a client that
  // understated (or omitted) `Content-Length` and then streamed 500 MB got us to
  // allocate all of it before being told 413. The declared length is a claim, and
  // §5 requires the cap hold regardless of it, so the only place the cap can
  // actually be enforced is while the bytes arrive.
  const body = request.body;
  if (body === null) {
    throw badRequest('bad_json', 'Body is not valid JSON.');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_WIRE_BYTES) {
        // Stop pulling immediately, and tell the peer we are done with its body.
        // Without the cancel, the runtime keeps draining a stream nobody will
        // read, which is the thing the cap exists to prevent.
        //
        // `waitUntil` rather than `await`: the cancel drains what the peer is
        // still sending, and awaiting it delays the 413 by exactly that long —
        // while §7 wants the emitter told to re-split as soon as we know.
        ctx.waitUntil(reader.cancel().catch(() => {}));
        throw payloadTooLarge('Body exceeds the wire limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // §5's limit is on UTF-8 BYTES of the serialized JSON — the byte total above,
  // not the decoded string's length. Checked after the wire cap so that a body
  // between the two limits gets the specific "re-split the batch" message §7's
  // 413 row expects an emitter to act on.
  if (total > MAX_BODY_BYTES) {
    throw payloadTooLarge(`Body exceeds the ${MAX_BODY_BYTES}-byte limit. Re-split the batch.`);
  }

  // Non-fatal by default: invalid UTF-8 becomes U+FFFD rather than throwing, and
  // the resulting JSON.parse failure is a clean 400 (§0: the body is UTF-8 JSON
  // with no BOM, which TextDecoder strips for us anyway). Decoded in one pass
  // over a single joined buffer so a multi-byte scalar split across two chunks
  // cannot become U+FFFD.
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Is this D1 failure about the SHAPE of the data rather than the health of the
 * database?
 *
 * Message matching, reluctantly. SQLite reports these as text and D1 surfaces no
 * error code, so there is nothing else to match on — but note what this is and is
 * not used for. It is NOT used to detect a duplicate batch: that question is
 * answered by asking the database (`SELECT … FROM batches`, above), precisely so
 * that a D1 message change cannot turn duplicates into 500s. Here the fallback is
 * safe in the other direction: an unrecognized message falls through to the 503,
 * which retains the batch. A message change therefore costs us the improvement,
 * never data.
 *
 * The patterns are the constraint classes a STRICT schema raises for bad values:
 * an out-of-range integer, a NULL in a NOT NULL column, a failed CHECK, and a
 * bad type for a STRICT column.
 */
function isDataShapedFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : '';
  return /datatype mismatch|cannot store .* value|NOT NULL constraint failed|CHECK constraint failed|out of range/i.test(
    message,
  );
}

/**
 * Is this D1 failure about the SIZE of what we asked it to store?
 *
 * Split out of `isDataShapedFailure`, which used to fold "too big" in with
 * "wrong type" and answer 400 for both. That was wrong in the expensive
 * direction: §7 makes a 400 a PERMANENT DROP, so a batch that D1 refused merely
 * for being large — the largest legal batch is 100 events × 32 props, and the
 * statement payload for it is several times the 256 KiB body — was thrown away
 * by the emitter when re-splitting it would have worked.
 *
 * 413 is the honest answer and the one §7 defines for exactly this: the emitter
 * re-splits into smaller batches with NEW `batchId`s and retries those, and if a
 * single event still cannot be stored it drops that one event rather than the
 * whole batch. Neither outcome is an infinite retry loop, which is why this is
 * not a 5xx either.
 *
 * The patterns are deliberately narrow — SQLite's own storage-limit messages,
 * not a generic "too large" — because a broader match (e.g. `/too large|too
 * big|exceeds the limit/i`) also catches platform faults that are NOT about
 * what we asked D1 to store: a Workers response-size or subrequest-limit error
 * can legitimately contain "exceeds the limit" or "too large" text. Classifying
 * one of those as 413 tells the emitter to re-split and retry with a NEW
 * `batchId`, and for a single event that has nowhere smaller to split to, §7
 * has the emitter DROP it — permanently discarding data over a fault that a
 * plain retry (the 503 path) would have recovered from. An unmatched message
 * still falls through to 503, which only costs us the improvement, never data.
 */
function isSizeShapedFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : '';
  return /string or blob too big|SQLITE_TOOBIG|too many SQL variables/i.test(message);
}

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Date,
): Promise<Response> {
  // Order is deliberate. Cheap header checks first, then auth, then the body:
  // an unauthenticated caller never gets us to read or parse a 256 KiB body.
  //
  // §7: `X-Stats-Read-Key` on this path is IGNORED — not 400, not 401 — because
  // both of those are permanent drops for the emitter. There is intentionally no
  // code here that looks at it.
  checkContentType(request.headers.get('content-type'));
  checkContentEncoding(request.headers.get('content-encoding'));

  const presentedKey = request.headers.get('x-stats-key');
  // PRE-AUTH, keyed on SHA-256 of the presented key and never on the IP (§13).
  // Before `resolveKey`, because `resolveKey` costs a D1 read: running the
  // limiter after it would hand a key-guessing loop one free storage read per
  // attempt, which is the expensive half of the request.
  await checkPreAuthRate(presentedKey, now.getTime());

  const scope = await resolveKey(env.DB, presentedKey, 'write');
  // And again per project, so minting more keys for one project does not multiply
  // its share.
  checkProjectRate(scope.projectId, now.getTime());
  // Record the key as live (0004), coalesced to at most one write per minute per
  // key. Registered here rather than after the commit, so it means "this key
  // authenticated a request" — which is the question rotation asks — and so
  // every outcome (accepted, duplicate, rejected body) counts the same: the
  // promise is handed to `waitUntil` before any of the code below can throw.
  //
  // `waitUntil` and not `await`: `last_used_at` is a diagnostic, and §7 makes the
  // 202 a durability signal about the BATCH. Nothing about this write belongs
  // between the emitter and its acknowledgement. It never throws (`touchKey`
  // swallows and logs its own failures), so nothing here can fail the request.
  ctx.waitUntil(touchKey(env.DB, scope, now));

  const batch = validateBatch(parseJsonBody(await readBody(request, ctx)));

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
    //
    // Deferred: it describes a batch we are about to accept, so it has no
    // business sitting between the client and its 202.
    deferLog(ctx, () =>
      logger.warn('props_adjusted', {
        projectId,
        adjustments: batch.propsAdjustments,
        events: batch.events.length,
      }),
    );
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

  // PER-EVENT idempotency, on top of the batch-level dedupe above (migration
  // 0003). `ON CONFLICT DO NOTHING` against the UNIQUE index on
  // (project_id, install_id, seq): a replay of already-stored events under a
  // FRESH `batchId` — what a crash between our 202 and the emitter's queue
  // marker produces — silently stores nothing rather than double-counting into
  // rollups that are kept indefinitely.
  //
  // `ON CONFLICT (…) DO NOTHING` and not `INSERT OR IGNORE`: `OR IGNORE`
  // suppresses EVERY constraint class on the row, including a NOT NULL or a
  // STRICT datatype failure, which are exactly the failures the catch block
  // below turns into an honest 400. Naming the conflict target keeps this
  // narrow to the identity index; anything else still throws.
  //
  // The batch row's INSERT stays a plain INSERT, and stays first: the duplicate
  // -`batchId` path (§6, below) depends on that statement failing the whole D1
  // batch atomically.
  const insertEvent = env.DB.prepare(
    `INSERT INTO events (
       project_id, batch_id, day, ts, name, session_id, install_id, app_id, seq, user_id, props, is_debug
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
     ON CONFLICT (project_id, install_id, seq) DO NOTHING`,
  );

  // First-seen day per distinct install in this batch, folded as we go (0005).
  // The MINIMUM bucket day, not the first event's: a batch is not ordered, and an
  // install seen for the first time in a batch that also carries a queued
  // yesterday event was first seen yesterday.
  const firstSeen = new Map<string, string>();

  for (const e of batch.events) {
    // §10: a future-dated or implausibly old `ts` is tolerated and clamped into
    // the retention window for AGGREGATION — the PROJECT's window (0006), which
    // is why `scope.retentionDays` is threaded through here. `ts` itself is
    // stored verbatim alongside it.
    const day = bucketDay(e.ts, now, scope.retentionDays);
    const seen = firstSeen.get(e.installId);
    if (seen === undefined || day < seen) firstSeen.set(e.installId, day);

    statements.push(
      insertEvent.bind(
        projectId,
        batch.batchId,
        day,
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

  // Index of the first event statement: the batch row, then the context row.
  const EVENT_STATEMENTS_FROM = 2;
  // …and one past the last. The `installs` statement below is appended AFTER the
  // events, and an `INSERT OR IGNORE` that hits a known install reports zero
  // changed rows exactly like a deduped event does — so the dedupe tally has to
  // stop at the end of the event range or every repeat visitor would be counted
  // as a replayed event.
  const EVENT_STATEMENTS_TO = EVENT_STATEMENTS_FROM + batch.events.length;

  let deduped = 0;

  // ONE statement for every distinct install in the batch, not one per event and
  // not one per install (0005). A 100-event batch from one install is a single
  // `INSERT OR IGNORE` with one row; the §1 batching rules already guarantee a
  // batch never mixes install ids, so in practice this is always one row — the
  // multi-row form exists so the statement stays correct if that ever changes,
  // without reintroducing a per-event write.
  //
  // In the SAME `db.batch()` as the events, so it commits with them or not at
  // all: a duplicate `batchId` (§6) aborts the whole batch and cannot leave an
  // `installs` row behind for events that were never written. It also composes
  // cleanly with the per-event identity index (0003): a batch replayed under a
  // fresh `batchId` has its events swallowed by `ON CONFLICT DO NOTHING` and its
  // `installs` row swallowed by `OR IGNORE`, so neither table double-counts.
  //
  // `OR IGNORE` is what keeps `first_seen_day` immutable — a later batch from a
  // known install is a no-op, so the column is the FIRST sighting, never the
  // latest.
  if (firstSeen.size > 0) {
    const installs = [...firstSeen.entries()];
    const values = installs.map((_, i) => `(?1, ?${i * 2 + 2}, ?${i * 2 + 3})`).join(', ');
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO installs (project_id, install_id, first_seen_day)
         VALUES ${values}`,
      ).bind(projectId, ...installs.flatMap(([installId, day]) => [installId, day])),
    );
  }

  try {
    const results = await env.DB.batch(statements);
    // How many events the identity index swallowed. D1 reports `meta.changes`
    // per statement, and a `DO NOTHING` conflict is 0 changed rows — so the
    // count is derivable without a second query. Defensive `?? 1`: if a D1
    // version stops reporting `changes`, assume the row landed, so an unknown
    // becomes an under-report of dedupes rather than a phantom alert.
    for (let i = EVENT_STATEMENTS_FROM; i < EVENT_STATEMENTS_TO; i += 1) {
      if ((results[i]?.meta?.changes ?? 1) === 0) deduped += 1;
    }
  } catch (cause) {
    // Distinguish "duplicate batch" from a real fault by ASKING THE DATABASE,
    // not by matching the driver's error string — a message change in D1 must
    // not silently turn duplicates into 500s (which the emitter would retry
    // forever) or faults into 202s (which would lose data).
    // Scoped to the project, matching the (project_id, batch_id) primary key —
    // another tenant's row must never be able to answer this question.
    //
    // This SELECT is itself a D1 call, made while we already know D1 just
    // failed us once. If D1 is down rather than merely rejecting this batch,
    // the SELECT throws too — and an unguarded throw here would escape this
    // catch block entirely, past every status check below, as a generic
    // uncaught 500 with no `retry-after`. That is strictly worse than the 503
    // path below: a bare 500 tells the emitter nothing about whether to retry,
    // where 503 (§7) is the honest "retain and retry" signal. So this lookup
    // gets its own try/catch: on failure we give up on distinguishing
    // "duplicate" from "fault" and fall through to the 503 path, which is safe
    // either way — a duplicate retried as 503 just gets retried again and
    // caught by the primary key next time, not lost.
    let existing: { ok: number } | null = null;
    try {
      existing = await env.DB.prepare(
        `SELECT 1 AS ok FROM batches WHERE project_id = ?1 AND batch_id = ?2`,
      )
        .bind(projectId, batch.batchId)
        .first<{ ok: number }>();
    } catch {
      // No `cause` here (deliberately): `logger.warn` takes no `cause` param —
      // only `logger.error` does, via `classifyError` — and classifying two
      // stacked D1 failures onto the same log line would be misleading anyway.
      // The fields already say what happened; the message text stays unlogged.
      logger.warn('duplicate_check_failed', { projectId });
    }

    if (existing !== null) {
      // §6: a duplicate is a SUCCESS. 202, exactly as for a first delivery, so
      // the emitter deletes it from its queue instead of retrying forever.
      deferLog(ctx, () =>
        logger.info('batch_duplicate', { projectId, events: batch.events.length, duplicate: true }),
      );
      return json({ accepted: batch.events.length, duplicate: true }, 202);
    }

    // Size first: §7 gives a size failure its own status (413 → re-split), and
    // folding it into the 400 below would drop data that a smaller batch stores.
    if (isSizeShapedFailure(cause)) {
      logger.error('ingest_too_large_for_storage', { projectId, events: batch.events.length }, cause);
      throw payloadTooLarge(
        'This batch is too large for the backend to store. Re-split it into smaller batches.',
      );
    }

    // A DATA-SHAPED failure is not a fault, and must not be signalled as one.
    // §7 makes a 5xx retain-and-retry, so answering 503 for a row the database
    // will never accept is an infinite retry loop: the emitter re-sends the same
    // bytes until the 24-hour ceiling drops them, having hit the backend every
    // time. Those are 400s — permanent, which is the truth.
    //
    // The validator bounds every field that can produce one of these, so reaching
    // here means the validator and the schema have drifted apart; it is logged at
    // `error` for exactly that reason, and the emitter is still told the honest
    // answer rather than being asked to retry forever.
    if (isDataShapedFailure(cause)) {
      logger.error('ingest_rejected_by_storage', { projectId, events: batch.events.length }, cause);
      throw badRequest(
        'invalid_event',
        'A field in this batch is outside the range this backend can store. It will not become valid on retry.',
      );
    }

    logger.error('ingest_failed', { projectId, events: batch.events.length }, cause);
    // §7: return 5xx and let the client retry rather than accepting-and-losing.
    throw new HttpError(503, 'internal_error', 'Storage unavailable. Retry with backoff.', {
      'retry-after': '5',
    });
  }

  // 202 only now: `db.batch()` has committed, so the batch would survive the
  // process dying (§7). Nothing between that commit and this `return` may block
  // — the success log runs after the response, under `waitUntil`.
  deferLog(ctx, () =>
    logger.info('batch_accepted', {
      projectId,
      events: batch.events.length,
      sdkVersion: batch.context.sdkVersion,
    }),
  );
  if (deduped > 0) {
    // A replay under a fresh `batchId` (see the insert above). Counts only —
    // no event name, no `installId`, no `seq`, no body (§7, §13). Deferred,
    // like every other log describing an already-decided outcome.
    deferLog(ctx, () =>
      logger.info('events_deduped', { projectId, events: batch.events.length, deduped }),
    );
  }
  // Still 202, and still `accepted: <events in the batch>`. §7's contract is
  // about durability, not novelty: every event in this batch is stored exactly
  // once, which is what the emitter needs in order to drop it from its queue.
  // Reporting the de-duplicated count instead would read as partial acceptance
  // and invite a retry of events we already hold.
  return json({ accepted: batch.events.length }, 202);
}
