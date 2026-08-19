// POST /v1/events conformance — docs/schema.md §1–§7.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import {
  DB,
  INSTALLS,
  OTHER_WRITE_KEY,
  PROJECT,
  REVOKED_WRITE_KEY,
  READ_KEY,
  batchId,
  ingestRequest,
  makeBatch,
  makeContext,
  makeEvent,
  readRequest,
  resetDatabase,
  WRITE_KEY,
} from './helpers.js';
import {
  PRE_AUTH_LIMIT_PER_WINDOW,
  READ_LIMIT_PER_WINDOW,
  RATE_WINDOW_MS,
  checkPreAuthRate,
  countAgainst,
  resetRateLimiter,
} from '../src/ratelimit.js';
import type { HttpError } from '../src/errors.js';

async function post(body: unknown, init?: Parameters<typeof ingestRequest>[1]): Promise<Response> {
  const request = ingestRequest(body, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function eventCount(): Promise<number> {
  const row = await DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await resetDatabase();
  // The limiter's buckets are module state shared across every test in this
  // isolate; a test that deliberately fills one must not leak into the next.
  resetRateLimiter();
});

describe('happy path', () => {
  it('accepts a well-formed batch with 202 and stores the rows', async () => {
    const response = await post(makeBatch());
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('application/json');

    const row = await DB.prepare(
      `SELECT project_id, name, ts, day, install_id, session_id, seq, props, is_debug
         FROM events`,
    ).first<Record<string, unknown>>();

    expect(row?.project_id).toBe(PROJECT);
    expect(row?.name).toBe('project_opened');
    // `ts` is stored verbatim (§0), and `day` is its UTC calendar day (§8.1).
    expect(row?.ts).toBe('2026-08-17T14:03:11.482Z');
    expect(row?.is_debug).toBe(0);
  });

  it('accepts a full 100-event batch in one D1 transaction', async () => {
    // The largest batch §5 permits becomes 102 statements in one `db.batch()`
    // (the batch row, the context row, 100 events), each binding at most 19
    // parameters. This asserts D1 actually accepts that shape — if a platform
    // limit ever bites, it bites at exactly the maximum legal batch, which is
    // the case a small fixture would never reach.
    const events = Array.from({ length: 100 }, (_, i) => makeEvent({ seq: i }));
    const response = await post(makeBatch({ events }));
    expect(response.status).toBe(202);
    expect(await eventCount()).toBe(100);
  });

  it('sets no cookie and issues no redirect', async () => {
    const response = await post(makeBatch());
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.status).toBe(202);
  });

  it('derives projectId from the key when the client sends none', async () => {
    // §2.4: absent `projectId` is perfectly valid; the derived value applies.
    await post(makeBatch({ events: [makeEvent({ projectId: null })] }));
    const row = await DB.prepare(`SELECT project_id FROM events`).first<{ project_id: string }>();
    expect(row?.project_id).toBe(PROJECT);
  });

  it('stores the context once per batch, not once per event', async () => {
    await post(
      makeBatch({
        events: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })],
      }),
    );
    const ctxRows = await DB.prepare(`SELECT COUNT(*) AS n FROM batch_context`).first<{ n: number }>();
    expect(await eventCount()).toBe(3);
    expect(ctxRows?.n).toBe(1);
  });

  it('ignores X-Stats-Read-Key on the ingest path', async () => {
    // §7: a backend MUST ignore it here — never 400, never 401, because both are
    // permanent drops for the emitter.
    const response = await post(makeBatch(), { headers: { 'x-stats-read-key': READ_KEY } });
    expect(response.status).toBe(202);
  });
});

describe('forward compatibility (§0)', () => {
  it('ignores unknown envelope, event and context keys', async () => {
    const body = makeBatch({
      context: makeContext({ futureField: 'whatever', anotherOne: 42 }),
      events: [{ ...makeEvent(), unknownEventKey: true }],
    });
    (body as Record<string, unknown>).unknownEnvelopeKey = ['anything'];

    const response = await post(body);
    expect(response.status).toBe(202);
    expect(await eventCount()).toBe(1);
  });

  it('accepts unknown osName and arch values, stored verbatim', async () => {
    // §3: a new Apple platform, or the reserved `web` / `wasm32`, must not need a
    // schema bump.
    await post(makeBatch({ context: makeContext({ osName: 'holodeckOS', arch: 'wasm32' }) }));
    const row = await DB.prepare(`SELECT os_name, arch FROM batch_context`).first<{
      os_name: string;
      arch: string;
    }>();
    expect(row?.os_name).toBe('holodeckOS');
    expect(row?.arch).toBe('wasm32');
  });

  it('accepts the consent-reduced context fallbacks of §3', async () => {
    const response = await post(
      makeBatch({
        context: makeContext({
          osVersion: '15',
          deviceModel: 'unknown',
          locale: 'en',
          region: 'ZZ',
          screenWidth: 0,
          screenHeight: 0,
          screenScale: 1.0,
          colorScheme: undefined,
        }),
      }),
    );
    expect(response.status).toBe(202);
  });
});

describe('idempotency (§6)', () => {
  it('returns 202 for a duplicate batchId and does not double-write', async () => {
    const id = batchId(9001);
    const first = await post(makeBatch({ batchId: id }));
    const second = await post(makeBatch({ batchId: id }));

    expect(first.status).toBe(202);
    // A duplicate is a SUCCESS, not an error — otherwise the emitter retries
    // forever. This is the assertion that fails if the dedupe is implemented as
    // a 409 or a 400.
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await eventCount()).toBe(1);
  });

  it('treats a lowercase batchId as the same batch as its uppercase form', async () => {
    // §1: a backend MUST accept either case and uppercase before keying the
    // dedupe. Without that, one retry from a lowercase-emitting client doubles
    // the data — which is exactly what `eventCount() === 1` catches here.
    const id = batchId(9002);
    expect((await post(makeBatch({ batchId: id }))).status).toBe(202);
    expect((await post(makeBatch({ batchId: id.toLowerCase() }))).status).toBe(202);
    expect(await eventCount()).toBe(1);
  });

  it('dedupes per project, so two tenants cannot collide on one batchId', async () => {
    // Dedupe is keyed on (project_id, batch_id). With a global key, the second
    // delivery below would be treated as a duplicate and project `someone-else`
    // would get a 202 having written nothing at all.
    const id = batchId(9005);
    expect((await post(makeBatch({ batchId: id }))).status).toBe(202);

    const other = await post(makeBatch({ batchId: id, events: [makeEvent({ projectId: null })] }), {
      key: OTHER_WRITE_KEY,
    });
    expect(other.status).toBe(202);
    expect(await other.json()).not.toMatchObject({ duplicate: true });
    expect(await eventCount()).toBe(2);
  });

  it('dedupes per install, so a reinstall\'s restarted seq is still two events', async () => {
    // §2.2's reinstall caveat, which is why the identity key carries
    // `install_id`: a reinstall restarts `seq` at 0 but under a NEW install
    // UUID, so (project_id, install_id, seq) does not collide and both events
    // are stored.
    await post(makeBatch({ batchId: batchId(9003), events: [makeEvent({ seq: 0 })] }));
    await post(
      makeBatch({ batchId: batchId(9004), events: [makeEvent({ seq: 0, installId: INSTALLS.b })] }),
    );
    expect(await eventCount()).toBe(2);
  });

  it('dedupes per project, so two tenants cannot collide on (installId, seq)', async () => {
    await post(makeBatch({ batchId: batchId(9006), events: [makeEvent({ seq: 7 })] }));
    const other = await post(
      makeBatch({ batchId: batchId(9007), events: [makeEvent({ seq: 7, projectId: null })] }),
      { key: OTHER_WRITE_KEY },
    );
    expect(other.status).toBe(202);
    expect(await eventCount()).toBe(2);
  });
});

/**
 * Per-event idempotency — migration 0003.
 *
 * The gap batch-level dedupe cannot close: the emitter is 202'd, crashes before
 * its local queue marker is written, and replays the SAME events under a FRESH
 * `batchId` (§6 requires a reconstructed batch get a new id). Two `batchId`s,
 * one set of events, and rollups that are kept indefinitely double-counting
 * them. The UNIQUE index on (project_id, install_id, seq) is what catches it.
 */
describe('per-event idempotency (migration 0003)', () => {
  const eventsFor = (seqs: number[], installId?: string) =>
    seqs.map((seq) => makeEvent({ seq, installId }));

  async function storedSeqs(installId?: string): Promise<number[]> {
    const { results } = await DB.prepare(
      `SELECT seq FROM events WHERE install_id = ?1 ORDER BY seq`,
    )
      .bind(installId ?? INSTALLS.a)
      .all<{ seq: number }>();
    return results.map((r) => r.seq);
  }

  it('202s a replay under a fresh batchId and stores each event exactly once', async () => {
    const events = eventsFor([0, 1, 2]);
    expect((await post(makeBatch({ batchId: batchId(9101), events }))).status).toBe(202);

    const replay = await post(makeBatch({ batchId: batchId(9102), events }));
    // Not the §6 `duplicate` path — this is a genuinely new batch row whose
    // events happen to all be already-stored. 202 either way, and `accepted`
    // still names the events in the batch so the emitter drops them.
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ accepted: 3 });

    expect(await eventCount()).toBe(3);
    expect(await storedSeqs()).toEqual([0, 1, 2]);
    // The batch row for the replay still committed: the batches table is the
    // §6 ledger of deliveries, not of events.
    const batches = await DB.prepare(`SELECT COUNT(*) AS n FROM batches`).first<{ n: number }>();
    expect(batches?.n).toBe(2);
  });

  it('stores only the new seqs of a partially overlapping replay', async () => {
    await post(makeBatch({ batchId: batchId(9103), events: eventsFor([10, 11, 12]) }));
    const overlap = await post(
      makeBatch({ batchId: batchId(9104), events: eventsFor([11, 12, 13, 14]) }),
    );
    expect(overlap.status).toBe(202);
    expect(await overlap.json()).toMatchObject({ accepted: 4 });
    expect(await storedSeqs()).toEqual([10, 11, 12, 13, 14]);
  });

  it('keeps the FIRST delivery of a (installId, seq), not the replay', async () => {
    await post(
      makeBatch({
        batchId: batchId(9105),
        events: [makeEvent({ seq: 5, name: 'project_opened' })],
      }),
    );
    await post(
      makeBatch({ batchId: batchId(9106), events: [makeEvent({ seq: 5, name: 'token_verified' })] }),
    );
    const row = await DB.prepare(`SELECT name FROM events WHERE seq = 5`).first<{ name: string }>();
    expect(row?.name).toBe('project_opened');
    expect(await eventCount()).toBe(1);
  });

  it('does not dedupe under denied `identity` consent (§11 ephemeral install ids)', async () => {
    // §11: with `identity` denied the emitter uses a fresh random install id
    // PER SESSION, and `seq` is monotonic within each. Two sessions therefore
    // both start near 0 with identical event shapes — and must both be stored,
    // because the `install_id` differs. This is the case that would silently
    // lose the most data if the key omitted `install_id`.
    const sessionA = 'c'.repeat(64);
    const sessionB = 'd'.repeat(64);
    await post(makeBatch({ batchId: batchId(9107), events: eventsFor([0, 1], sessionA) }));
    const second = await post(
      makeBatch({ batchId: batchId(9108), events: eventsFor([0, 1], sessionB) }),
    );
    expect(second.status).toBe(202);
    expect(await eventCount()).toBe(4);
    expect(await storedSeqs(sessionA)).toEqual([0, 1]);
    expect(await storedSeqs(sessionB)).toEqual([0, 1]);
  });

  it('logs events_deduped after the response, with counts and nothing person-scale', async () => {
    await post(makeBatch({ batchId: batchId(9109), events: eventsFor([20, 21]) }));

    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const request = ingestRequest(
        makeBatch({ batchId: batchId(9110), events: eventsFor([20, 21, 22]) }),
      );
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as never, ctx);
      expect(response.status).toBe(202);
      await waitOnExecutionContext(ctx);
    } finally {
      console.log = realLog;
    }

    const deduped = lines.filter((l) => l.includes('events_deduped'));
    expect(deduped.length).toBe(1);
    expect(JSON.parse(deduped[0] as string)).toMatchObject({
      level: 'info',
      event: 'events_deduped',
      projectId: PROJECT,
      events: 3,
      deduped: 2,
    });
    // §13 / src/log.ts: no installId, no seq, no name, no body.
    expect(deduped[0]).not.toContain(INSTALLS.a);
    expect(deduped[0]).not.toContain('project_opened');
  });

  it('does not log events_deduped when nothing was deduped', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const request = ingestRequest(makeBatch({ batchId: batchId(9111), events: eventsFor([30]) }));
      const ctx = createExecutionContext();
      await worker.fetch(request, env as never, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      console.log = realLog;
    }
    expect(lines.filter((l) => l.includes('events_deduped'))).toEqual([]);
    expect(lines.filter((l) => l.includes('batch_accepted')).length).toBe(1);
  });

  it('still rejects a data-shaped failure rather than silently ignoring the row', async () => {
    // `ON CONFLICT … DO NOTHING` is deliberately narrower than `INSERT OR
    // IGNORE`, which would also swallow a NOT NULL / STRICT datatype failure —
    // the failures the handler answers 400 for. A duplicate `batchId` is the
    // only conflict that may abort the batch.
    const id = batchId(9112);
    await post(makeBatch({ batchId: id, events: eventsFor([40]) }));
    const dupe = await post(makeBatch({ batchId: id, events: eventsFor([41]) }));
    expect(dupe.status).toBe(202);
    expect(await dupe.json()).toMatchObject({ duplicate: true });
    // The whole batch aborted on the batches PK, so seq 41 was NOT written.
    expect(await storedSeqs()).toEqual([40]);
  });
});

describe('authentication (§7)', () => {
  it('401s a missing key', async () => {
    const response = await post(makeBatch(), { key: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('401s an unknown key', async () => {
    const response = await post(makeBatch(), { key: 'sk_stats_not_a_real_key_at_all_000000000' });
    expect(response.status).toBe(401);
  });

  it('401s a revoked key', async () => {
    const response = await post(makeBatch(), { key: REVOKED_WRITE_KEY });
    expect(response.status).toBe(401);
    expect(await eventCount()).toBe(0);
  });

  it('401s a READ key presented to the ingest endpoint', async () => {
    // A read key must not be able to write, the mirror of §8's "a write key
    // grants no reads". The `kind` filter in the SQL is what makes this pass.
    const response = await post(makeBatch(), { key: READ_KEY });
    expect(response.status).toBe(401);
  });

  it('writes nothing at all when the key is bad', async () => {
    await post(makeBatch(), { key: null });
    const batches = await DB.prepare(`SELECT COUNT(*) AS n FROM batches`).first<{ n: number }>();
    expect(batches?.n).toBe(0);
  });
});

describe('projectId derivation (§2.4)', () => {
  it('400s a client projectId that disagrees with the key scope', async () => {
    const response = await post(makeBatch({ events: [makeEvent({ projectId: 'not-overwatch' })] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'project_mismatch' });
    expect(await eventCount()).toBe(0);
  });

  it('stores the key scope, never the client value, when they agree', async () => {
    await post(makeBatch({ events: [makeEvent({ projectId: PROJECT })] }), {});
    const row = await DB.prepare(`SELECT project_id FROM events`).first<{ project_id: string }>();
    expect(row?.project_id).toBe(PROJECT);
  });

  it("scopes a second project's key to that project", async () => {
    // Discriminating for "derives from the key" vs "trusts the client": the body
    // asserts nothing, and the only thing that can decide the stored project is
    // the key.
    await post(makeBatch({ events: [makeEvent({ projectId: null })] }), { key: OTHER_WRITE_KEY });
    const row = await DB.prepare(`SELECT project_id FROM events`).first<{ project_id: string }>();
    expect(row?.project_id).toBe('someone-else');
  });
});

describe('validation → 400 (§0, §2, §5)', () => {
  const cases: Array<[string, unknown, string]> = [
    ['unknown schema value', makeBatch({ schema: 'v2' }), 'bad_schema_version'],
    ['missing schema', makeBatch({ schema: undefined }), 'bad_schema_version'],
    ['empty events array', makeBatch({ events: [] }), 'empty_events'],
    [
      'more than 100 events',
      makeBatch({ events: Array.from({ length: 101 }, (_, i) => makeEvent({ seq: i })) }),
      'too_many_events',
    ],
    ['uppercase event name', makeBatch({ events: [makeEvent({ name: 'Project_Opened' })] }), 'invalid_event'],
    ['event name with a digit first', makeBatch({ events: [makeEvent({ name: '1_open' })] }), 'invalid_event'],
    ['stats_-prefixed name', makeBatch({ events: [makeEvent({ name: 'stats_internal' })] }), 'reserved_event_name'],
    ['props value is an object', makeBatch({ events: [makeEvent({ props: { a: { b: 1 } } })] }), 'invalid_event'],
    ['props value is an array', makeBatch({ events: [makeEvent({ props: { a: [1, 2] } })] }), 'invalid_event'],
    ['ts with a local offset', makeBatch({ events: [makeEvent({ ts: '2026-08-17T14:03:11.482+02:00' })] }), 'invalid_event'],
    ['ts without milliseconds', makeBatch({ events: [makeEvent({ ts: '2026-08-17T14:03:11Z' })] }), 'invalid_event'],
    ['installId not 64 hex', makeBatch({ events: [makeEvent({ installId: 'abc' })] }), 'invalid_event'],
    ['installId uppercase hex', makeBatch({ events: [makeEvent({ installId: 'A'.repeat(64) })] }), 'invalid_event'],
    ['malformed sessionId', makeBatch({ events: [makeEvent({ sessionId: 'nope' })] }), 'invalid_event'],
    ['sessionId suffix wrong width', makeBatch({ events: [makeEvent({ sessionId: '1786012978-4037185' })] }), 'invalid_event'],
    ['batchId not a UUID', makeBatch({ batchId: 'not-a-uuid' }), 'invalid_envelope'],
    ['sentAt malformed', makeBatch({ sentAt: 'yesterday' }), 'invalid_envelope'],
    [
      'projectId with a disallowed character',
      makeBatch({ events: [makeEvent({ projectId: 'over watch' })] }),
      'invalid_event',
    ],
    [
      'bundleId differing from appId',
      makeBatch({ context: makeContext({ bundleId: 'com.other.App' }) }),
      'invalid_event',
    ],
    [
      'mixed appId in one batch',
      makeBatch({
        context: makeContext(),
        events: [makeEvent({ seq: 1 }), makeEvent({ seq: 2, appId: 'com.other.App' })],
      }),
      'mixed_batch',
    ],
    [
      'mixed installId in one batch',
      makeBatch({ events: [makeEvent({ seq: 1 }), makeEvent({ seq: 2, installId: INSTALLS.b })] }),
      'mixed_batch',
    ],
    [
      'mixed projectId in one batch',
      makeBatch({
        events: [makeEvent({ seq: 1, projectId: PROJECT }), makeEvent({ seq: 2, projectId: 'other' })],
      }),
      'mixed_batch',
    ],
    ['context missing a required field', makeBatch({ context: makeContext({ appBuild: undefined }) }), 'invalid_envelope'],
    ['context isDebug not a bool', makeBatch({ context: makeContext({ isDebug: 'false' }) }), 'invalid_context'],
    ['negative seq', makeBatch({ events: [makeEvent({ seq: -1 })] }), 'invalid_event'],
    ['non-integer seq', makeBatch({ events: [makeEvent({ seq: 1.5 })] }), 'invalid_event'],
  ];

  for (const [label, body, code] of cases) {
    it(`400s: ${label}`, async () => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: code });
      expect(await eventCount()).toBe(0);
    });
  }

  it('400s malformed JSON', async () => {
    const response = await post('{"schema":"v1",');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'bad_json' });
  });

  it('400s a non-JSON Content-Type', async () => {
    const response = await post(makeBatch(), { contentType: 'text/plain' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'bad_content_type' });
  });

  it('accepts application/json with a charset parameter, in any case', async () => {
    const response = await post(makeBatch(), { contentType: 'Application/JSON; charset=UTF-8' });
    expect(response.status).toBe(202);
  });

  it('400s a gzipped body, since this backend does not support gzip', async () => {
    // §7: a backend that does not support gzip MUST reject rather than silently
    // mis-parse.
    const response = await post(makeBatch(), { headers: { 'content-encoding': 'gzip' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unsupported_encoding' });
  });

  it('never echoes the request body in an error response', async () => {
    // The marker must be asserted in the EXACT form that was sent. Sending
    // `marker.toUpperCase()` while asserting the lowercase form made this
    // unfalsifiable: the response could echo the name verbatim and still pass.
    const marker = 'CANARY_VALUE_THAT_MUST_NOT_COME_BACK';
    const response = await post(
      makeBatch({
        events: [makeEvent({ name: marker, props: { section: marker }, userId: marker })]
      })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(marker);
  });
});

describe('413 (§5)', () => {
  it('413s a body over 256 KiB', async () => {
    // 100 events each carrying ~3 KB of props: over the byte limit but within
    // the 100-event count limit, which is exactly the case §5 says the emitter
    // must split by bytes BEFORE count.
    const filler = 'x'.repeat(200);
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({
        seq: i,
        props: Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`prop_${k}`, filler])),
      }),
    );
    const body = JSON.stringify(makeBatch({ events }));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(262_144);

    const response = await post(body);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
    expect(await eventCount()).toBe(0);
  });

  it('accepts a body just under the limit', async () => {
    const filler = 'y'.repeat(200);
    const events = Array.from({ length: 20 }, (_, i) =>
      makeEvent({
        seq: i,
        props: Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`prop_${k}`, filler])),
      }),
    );
    const body = JSON.stringify(makeBatch({ events }));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(262_144);
    expect((await post(body)).status).toBe(202);
  });
});

describe('props enforcement (§2.3) — this backend truncates and drops', () => {
  it('truncates an over-long string value to 200 scalars', async () => {
    await post(makeBatch({ events: [makeEvent({ props: { section: 'z'.repeat(500) } })] }));
    const row = await DB.prepare(`SELECT props FROM events`).first<{ props: string }>();
    const props = JSON.parse(row?.props ?? '{}') as Record<string, string>;
    expect(props.section).toHaveLength(200);
  });

  it('keeps the first 32 keys in byte-wise ascending order and drops the rest', async () => {
    // §2.3: the surviving 32 are the first 32 in §0 byte order, so emitter and
    // backend keep the SAME 32. Keys are named so that ascending order is
    // p_00 … p_39: `p_00`–`p_31` must survive and `p_32`–`p_39` must not.
    const props = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`p_${String(i).padStart(2, '0')}`, i]),
    );
    await post(makeBatch({ events: [makeEvent({ props })] }));

    const row = await DB.prepare(`SELECT props FROM events`).first<{ props: string }>();
    const stored = Object.keys(JSON.parse(row?.props ?? '{}') as Record<string, unknown>);
    expect(stored).toHaveLength(32);
    expect(stored).toContain('p_00');
    expect(stored).toContain('p_31');
    expect(stored).not.toContain('p_32');
  });

  it('drops a non-conforming key but keeps the event', async () => {
    await post(makeBatch({ events: [makeEvent({ props: { Bad_Key: 1, good_key: 2 } })] }));
    const row = await DB.prepare(`SELECT props FROM events`).first<{ props: string }>();
    const props = JSON.parse(row?.props ?? '{}') as Record<string, unknown>;
    expect(props).toEqual({ good_key: 2 });
  });

  it('preserves an explicit null distinctly from an absent key', async () => {
    await post(makeBatch({ events: [makeEvent({ props: { section: null } })] }));
    const row = await DB.prepare(`SELECT props FROM events`).first<{ props: string }>();
    expect(JSON.parse(row?.props ?? '{}')).toEqual({ section: null });
  });

  it('400s an object props value even when the key would have been dropped anyway', async () => {
    // §2.3: a disallowed TYPE is always 400 and is not a size limit, so it must
    // not be masked by the key also being droppable.
    const response = await post(makeBatch({ events: [makeEvent({ props: { BadKey: { nested: 1 } } })] }));
    expect(response.status).toBe(400);
  });
});

describe('things a backend MUST NOT reject', () => {
  it('accepts more than one sessionId in a batch', async () => {
    // §1: a batch commonly spans a session boundary.
    const response = await post(
      makeBatch({
        events: [
          makeEvent({ seq: 1, sessionId: '1786012978-40371852' }),
          makeEvent({ seq: 2, sessionId: '1786013999-11112222' }),
        ],
      }),
    );
    expect(response.status).toBe(202);
    expect(await eventCount()).toBe(2);
  });

  it('accepts session_end whose ts is older than a lower-seq event (§12)', async () => {
    const response = await post(
      makeBatch({
        events: [
          makeEvent({ seq: 40, name: 'project_opened', ts: '2026-08-17T14:03:11.482Z' }),
          // session_end carries the PREVIOUS session's id and an older ts. The
          // one place in v1 where `ts` is not monotonic with `seq`.
          makeEvent({
            seq: 41,
            name: 'session_end',
            ts: '2026-08-17T13:00:00.000Z',
            sessionId: '1786010000-99998888',
            props: { duration_s: 120 },
          }),
        ],
      }),
    );
    expect(response.status).toBe(202);
    expect(await eventCount()).toBe(2);
  });

  it('accepts out-of-order seq', async () => {
    const response = await post(
      makeBatch({ events: [makeEvent({ seq: 9 }), makeEvent({ seq: 3 })] }),
    );
    expect(response.status).toBe(202);
  });

  it('accepts reserved auto-event names', async () => {
    // §12 reserves them against the APP, not the backend: the emitter's
    // auto-events legitimately carry them and must be stored.
    // Distinct `seq` per event: they are four different events of one install,
    // and (project_id, install_id, seq) is UNIQUE since migration 0003.
    const names = ['app_open', 'app_background', 'session_start', 'session_end'];
    for (const [i, name] of names.entries()) {
      const response = await post(
        makeBatch({ batchId: batchId(), events: [makeEvent({ name, seq: i })] }),
      );
      expect(response.status).toBe(202);
    }
    expect(await eventCount()).toBe(4);
  });

  it('tolerates a future-dated ts, clamping only the aggregation day (§10)', async () => {
    const response = await post(
      makeBatch({ events: [makeEvent({ ts: '2099-01-01T00:00:00.000Z' })] }),
    );
    expect(response.status).toBe(202);

    const row = await DB.prepare(`SELECT ts, day FROM events`).first<{ ts: string; day: string }>();
    // `ts` verbatim; `day` clamped to today so §8.1's "never a future row" holds.
    expect(row?.ts).toBe('2099-01-01T00:00:00.000Z');
    expect(row?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('tolerates a very old ts, clamping it into the retention window', async () => {
    const response = await post(
      makeBatch({ events: [makeEvent({ ts: '2001-01-01T00:00:00.000Z' })] }),
    );
    expect(response.status).toBe(202);
    const row = await DB.prepare(`SELECT day FROM events`).first<{ day: string }>();
    // Clamped forward, so the retention sweep can still reach it and it does not
    // become an immortal row.
    expect(row?.day).not.toBe('2001-01-01');
  });

  it('stores userId opaquely', async () => {
    await post(makeBatch({ events: [makeEvent({ userId: 'deadbeef'.repeat(4) })] }));
    const row = await DB.prepare(`SELECT user_id FROM events`).first<{ user_id: string }>();
    expect(row?.user_id).toBe('deadbeef'.repeat(4));
  });
});

describe('routing', () => {
  it('404s an unknown path', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://stats.example.com/v1/nope'),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  it('405s a GET on the ingest path', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://stats.example.com/v1/events'),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('integer bounds (§0: a data error is a 400, never a retriable 5xx)', () => {
  /**
   * `Number.isInteger(1e21)` is `true` — it is an integral `double` — so an
   * unbounded integer check accepted it, and D1 then threw on the STRICT INTEGER
   * insert. That throw was reported as **503 with Retry-After**, which §7 makes
   * RETAIN-and-retry: the emitter re-sent the identical bytes on a backoff until
   * the 24-hour ceiling dropped them, hitting the backend on every attempt, for a
   * row the database was never going to accept.
   *
   * These must be 400 — permanent, which is the truth — and they must be caught
   * by the validator, not by the database.
   */
  it.each([
    ['seq 1e21', () => makeBatch({ events: [makeEvent({ seq: 1e21 })] })],
    ['seq beyond MAX_SAFE_INTEGER', () => makeBatch({ events: [makeEvent({ seq: 2 ** 53 })] })],
    ['screenWidth 1e21', () => makeBatch({ context: makeContext({ screenWidth: 1e21 }) })],
    ['screenHeight 1e21', () => makeBatch({ context: makeContext({ screenHeight: 1e21 }) })],
    ['screenWidth negative', () => makeBatch({ context: makeContext({ screenWidth: -1 }) })],
    ['screenHeight negative', () => makeBatch({ context: makeContext({ screenHeight: -1 }) })],
    ['screenScale 1e21', () => makeBatch({ context: makeContext({ screenScale: 1e21 }) })],
  ])('400s %s rather than 503ing into an infinite retry', async (_label, build) => {
    const response = await post(build());
    expect(response.status).toBe(400);
    // Specifically NOT a 503 with a Retry-After, which is what made it a loop.
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await eventCount()).toBe(0);
  });

  it('still accepts the values a real device and §3 fallbacks produce', async () => {
    // The bounds must not reject anything legal. §3's consent-reduced fallback is
    // 0/0/1.0, and `seq` is monotonic per install without a practical ceiling.
    const response = await post(
      makeBatch({
        context: makeContext({ screenWidth: 0, screenHeight: 0, screenScale: 1.0 }),
        events: [makeEvent({ seq: Number.MAX_SAFE_INTEGER })],
      }),
    );
    expect(response.status).toBe(202);

    const wide = await post(
      makeBatch({
        batchId: batchId(),
        context: makeContext({ screenWidth: 7680, screenHeight: 4320, screenScale: 3 }),
        events: [makeEvent({ seq: 0 })],
      }),
    );
    expect(wide.status).toBe(202);
  });
});

describe('the 2 MiB wire cap is enforced while reading (§5)', () => {
  /**
   * The cap used to be applied AFTER `await request.arrayBuffer()`, so it bounded
   * what the Worker kept, not what it read. `Content-Length` is a claim: a client
   * can understate it, or send a chunked request with none at all, and then stream
   * as much as it likes. Here the declared length is 10 bytes and the body is
   * ~2.5 MiB.
   */
  function streamingRequest(totalBytes: number, declaredLength: string | null): Request {
    const chunkSize = 64 * 1024;
    const chunk = new TextEncoder().encode('x'.repeat(chunkSize));
    const chunks = Math.ceil(totalBytes / chunkSize);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ < chunks) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const headers = new Headers({
      'content-type': 'application/json',
      'x-stats-key': WRITE_KEY,
    });
    if (declaredLength !== null) headers.set('content-length', declaredLength);
    return new Request('https://stats.example.com/v1/events', {
      method: 'POST',
      headers,
      body,
      // @ts-expect-error `duplex` is required for a stream body and is not in the
      // ambient Request type used here.
      duplex: 'half',
    });
  }

  async function send(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('413s a 2.5 MiB body that declares a Content-Length of 10', async () => {
    const response = await send(streamingRequest(2_621_440, '10'));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
    expect(await eventCount()).toBe(0);
  });

  it('413s a 2.5 MiB body with no Content-Length at all', async () => {
    const response = await send(streamingRequest(2_621_440, null));
    expect(response.status).toBe(413);
    expect(await eventCount()).toBe(0);
  });

  it('a body between the 256 KiB batch limit and the wire cap gets the re-split message', async () => {
    // §7's 413 row tells the emitter to RE-SPLIT, which is only actionable for a
    // body under the wire cap. Ordering the two checks the other way round would
    // give this body the generic wire-cap message.
    const response = await send(streamingRequest(512 * 1024, null));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/Re-split/i);
  });

  it('still accepts a normal-sized streamed body', async () => {
    // The counting loop must not break the happy path, including a body that
    // arrives in more than one chunk.
    const json = JSON.stringify(makeBatch());
    const encoded = new TextEncoder().encode(json);
    const half = Math.floor(encoded.byteLength / 2);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, half));
        controller.enqueue(encoded.slice(half));
        controller.close();
      },
    });
    const request = new Request('https://stats.example.com/v1/events', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'x-stats-key': WRITE_KEY }),
      body,
      // @ts-expect-error see above
      duplex: 'half',
    });
    expect((await send(request)).status).toBe(202);
    expect(await eventCount()).toBe(1);
  });
});

describe('rate limiting (§7 429, §8.3 429)', () => {
  it('429s past the pre-auth limit, with a Retry-After', async () => {
    // Driven through the limiter directly: a hundred real requests per test is a
    // slow way to assert an arithmetic threshold.
    const now = Date.now();
    const bucket = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i += 1) countAgainst(bucket, now, 3);
    expect(() => countAgainst(bucket, now, 3)).toThrow();

    try {
      countAgainst(bucket, now, 3);
      expect.unreachable('the limiter must throw past the limit');
    } catch (cause) {
      const response = (cause as HttpError).toResponse();
      expect(response.status).toBe(429);
      // §7/§8.3: a 429 carries `Retry-After` in integer seconds, which is what
      // the emitter's disposition table reads.
      const retryAfter = response.headers.get('retry-after');
      expect(retryAfter).not.toBeNull();
      expect(Number.isInteger(Number(retryAfter))).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(await response.json()).toMatchObject({ error: 'rate_limited' });
    }
  });

  it('the window resets, so a limited client is not locked out forever', () => {
    const now = Date.now();
    const bucket = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i += 1) countAgainst(bucket, now, 2);
    expect(() => countAgainst(bucket, now, 2)).toThrow();
    // One window later the bucket is fresh.
    expect(() => countAgainst(bucket, now + RATE_WINDOW_MS, 2)).not.toThrow();
  });

  it('buckets on the key hash, and never on the IP (§13)', async () => {
    // Two different keys must not share a bucket, and the same key must share one
    // with itself regardless of any request header.
    const nowMs = Date.now();
    resetRateLimiter();

    // Fill one key's bucket to the limit.
    for (let i = 0; i < PRE_AUTH_LIMIT_PER_WINDOW; i += 1) {
      await checkPreAuthRate(WRITE_KEY, nowMs);
    }
    await expect(checkPreAuthRate(WRITE_KEY, nowMs)).rejects.toThrow();
    // A different key is untouched — so the bucket is per key, not global.
    await expect(checkPreAuthRate(OTHER_WRITE_KEY, nowMs)).resolves.toBeUndefined();

    resetRateLimiter();
  });

  it('the ingest path is limited BEFORE the key is resolved', async () => {
    // Pre-auth matters: `resolveKey` costs a D1 read, so limiting after it hands a
    // key-guessing loop one free storage read per attempt. An UNKNOWN key must
    // therefore be able to trip the limiter and get a 429 rather than a 401.
    resetRateLimiter();
    const unknownKey = 'sk_stats_this_key_does_not_exist_00000000000';

    // Below the limit it is a plain 401.
    expect((await post(makeBatch(), { key: unknownKey })).status).toBe(401);

    // Fill the bucket for that key, from empty — the 401 above already spent one.
    resetRateLimiter();
    const nowMs = Date.now();
    for (let i = 0; i < PRE_AUTH_LIMIT_PER_WINDOW; i += 1) {
      await checkPreAuthRate(unknownKey, nowMs);
    }
    const limited = await post(makeBatch({ batchId: batchId() }), { key: unknownKey });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();

    resetRateLimiter();
  });

  it('both read endpoints can emit §8.3 429s', async () => {
    // Before this there was no limiter on the read path at all, so §8.3's
    // documented 429 was unreachable — nothing in the Worker could produce one.
    resetRateLimiter();
    const nowMs = Date.now();
    for (let i = 0; i < PRE_AUTH_LIMIT_PER_WINDOW; i += 1) {
      await checkPreAuthRate(READ_KEY, nowMs);
    }

    const day = new Date().toISOString().slice(0, 10);
    for (const path of ['/v1/summary', '/v1/events/top']) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        readRequest(path, { projectId: PROJECT, from: day, to: day }, READ_KEY),
        env as never,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status, path).toBe(429);
      expect(response.headers.get('retry-after'), path).not.toBeNull();
      expect(await response.json()).toMatchObject({ error: 'rate_limited' });
    }

    resetRateLimiter();
  });
});

describe('post-response side effects run under ctx.waitUntil', () => {
  /**
   * §7 makes the 202 a durability signal, so nothing that is not durability may
   * sit between the D1 commit and the response. The success log is therefore
   * scheduled with `ctx.waitUntil` (see `deferLog` in src/log.ts) — which also
   * means it must still RUN, rather than being dropped when the response is
   * returned. `waitOnExecutionContext` is exactly the assertion that it did.
   */
  it('logs batch_accepted after the response, and the line carries nothing person-scale', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const request = ingestRequest(makeBatch({ events: [makeEvent({ userId: 'u-1' })] }));
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as never, ctx);
      expect(response.status).toBe(202);
      // The deferred work is only guaranteed to have run once the context drains.
      await waitOnExecutionContext(ctx);
    } finally {
      console.log = realLog;
    }

    const accepted = lines.filter((l) => l.includes('batch_accepted'));
    expect(accepted.length).toBe(1);
    const line = JSON.parse(accepted[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', event: 'batch_accepted', projectId: PROJECT, events: 1 });
    // §13 / src/log.ts: no installId, sessionId, userId, prop or key ever.
    expect(accepted[0]).not.toContain(INSTALLS.a);
    expect(accepted[0]).not.toContain('u-1');
    expect(accepted[0]).not.toContain(WRITE_KEY);
  });
});

describe('storage failures map to the status §7 defines for them', () => {
  /**
   * The three outcomes must stay distinct, because §7 makes each of them mean
   * something different to the emitter:
   *
   *   too big      -> 413, RE-SPLIT with new batchIds (data survives)
   *   wrong shape  -> 400, DROP (it will never become valid)
   *   anything else-> 5xx, RETAIN and retry (the database, not the data)
   *
   * Folding "too big" into the 400 — which is what the code used to do — turns a
   * batch that a smaller split would have stored into a permanent drop.
   */
  function envWhoseBatchThrows(message: string): { DB: D1Database } {
    // Everything except `batch()` is the real D1, so `resolveKey` and the
    // duplicate-check SELECT still behave exactly as in production.
    const db = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async () => {
            throw new Error(message);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { DB: db as D1Database };
  }

  async function postTo(env2: { DB: D1Database }): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(ingestRequest(makeBatch()), env2 as never, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('413s a size failure so the emitter re-splits instead of dropping', async () => {
    const response = await postTo(envWhoseBatchThrows('D1_ERROR: string or blob too big'));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
    expect(await eventCount()).toBe(0);
  });

  it('413s SQLITE_TOOBIG the same way', async () => {
    const response = await postTo(envWhoseBatchThrows('D1_ERROR: SQLITE_TOOBIG: string or blob too big'));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
    expect(await eventCount()).toBe(0);
  });

  it('503s a platform "too large" message that is not about storage, so a single event is retried rather than dropped', async () => {
    // A Workers response-size or subrequest-limit fault can say "too large" or
    // "exceeds the limit" without D1 having refused to STORE anything. §7 makes
    // 413 mean "re-split with new batchIds", and for a single event there is
    // nowhere smaller to split to — the emitter drops it permanently. That is
    // the wrong side to err on for a fault that a plain retry could recover
    // from, so this must land on 503 (retain), not 413 (permanently drop).
    const response = await postTo(
      envWhoseBatchThrows('Error: Response exceeds the limit for a single Worker invocation'),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  it('400s a data-shaped failure, which no retry can fix', async () => {
    const response = await postTo(envWhoseBatchThrows('D1_ERROR: datatype mismatch'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_event' });
  });

  it('503s an unrecognized failure, so a transient fault RETAINS the batch', async () => {
    // The critical direction: a database that is merely unwell must never look
    // like a permanent 4xx, or a healthy batch is dropped for good.
    const response = await postTo(envWhoseBatchThrows('Network connection lost'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  it('never echoes the request body in an error response (§7)', async () => {
    const response = await postTo(envWhoseBatchThrows('Network connection lost'));
    const text = await response.text();
    expect(text).not.toContain(INSTALLS.a);
    expect(text).not.toContain('com.wizemann.Overwatch');
  });

  it('503s when the duplicate-check SELECT itself throws, instead of escaping as a bare 500', async () => {
    // `batch()` fails, and the handler's own duplicate-detection SELECT — asking
    // "did this batchId already commit?" — is itself a D1 call made against a
    // database we already know just failed. If D1 is actually down rather than
    // merely rejecting this one batch, that SELECT throws too. Unguarded, that
    // throw would escape the whole catch block as a generic uncaught error
    // with no status mapping and no `retry-after`, instead of the 503 §7 wants
    // for "the database, not the data".
    const db = new Proxy(DB, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async () => {
            throw new Error('Network connection lost');
          };
        }
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('FROM batches WHERE')) {
              return {
                bind: () => ({
                  first: async () => {
                    throw new Error('Network connection lost');
                  },
                }),
              };
            }
            return (Reflect.get(target, prop, receiver) as typeof target.prepare).call(target, sql);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await postTo({ DB: db as D1Database });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });
});

describe('the largest batch §5 permits (100 events x 32 props)', () => {
  it('ingests in one D1 batch — 102 statements, 19 bound params at most', async () => {
    // D1 caps BOUND PARAMETERS PER STATEMENT (100), not statements per batch;
    // the widest statement here is the context row at 19, and each event insert
    // binds 12. This is the shape that would find a platform limit if one moved,
    // and it is also the largest body §5 allows through, so it pins both.
    const props: Record<string, string> = {};
    for (let i = 0; i < 32; i += 1) props[`prop_${i.toString().padStart(2, '0')}`] = 'v'.repeat(60);
    const events = Array.from({ length: 100 }, (_, i) => makeEvent({ seq: i, props }));
    const body = makeBatch({ events });

    // The fixture must stay a LEGAL batch, or the assertion below proves nothing.
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(262_144);

    const response = await post(body);
    expect(response.status).toBe(202);
    expect(await eventCount()).toBe(100);

    const row = await DB.prepare(`SELECT props FROM events LIMIT 1`).first<{ props: string }>();
    expect(Object.keys(JSON.parse(row?.props ?? '{}') as object).length).toBe(32);
  });
});

describe('HEAD and method routing', () => {
  async function fetchMethod(path: string, method: string, headers: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://stats.example.com${path}`, { method, headers }),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('answers HEAD on /health, which an uptime check uses', async () => {
    // workerd does NOT synthesize HEAD from GET — it arrives as `method: HEAD`
    // — so this used to be a 405 for every uptime checker that defaults to HEAD.
    expect((await fetchMethod('/health', 'HEAD')).status).toBe(200);
    expect((await fetchMethod('/health', 'GET')).status).toBe(200);
  });

  it('answers HEAD on the read endpoints, which are safe and idempotent (§8)', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const response = await fetchMethod(
      `/v1/summary?projectId=${PROJECT}&from=${day}&to=${day}`,
      'HEAD',
      { 'x-stats-read-key': READ_KEY },
    );
    expect(response.status).toBe(200);
  });

  it('405s a write method on a read path, and on /health', async () => {
    expect((await fetchMethod('/v1/summary', 'POST')).status).toBe(405);
    expect((await fetchMethod('/health', 'POST')).status).toBe(405);
    expect((await fetchMethod('/v1/events', 'HEAD')).status).toBe(405);
  });
});

describe('the read limiter is tighter than the ingest limiter', () => {
  it('429s a read key past READ_LIMIT_PER_WINDOW, well below the ingest ceiling', async () => {
    // A read key is one dashboard (§8 forbids embedding it in an app); a write
    // key is a whole fleet. One number cannot be right for both, and the tighter
    // one must be the read one.
    expect(READ_LIMIT_PER_WINDOW).toBeLessThan(PRE_AUTH_LIMIT_PER_WINDOW);
    resetRateLimiter();
    const nowMs = Date.now();
    for (let i = 0; i < READ_LIMIT_PER_WINDOW; i += 1) {
      await checkPreAuthRate(READ_KEY, nowMs, READ_LIMIT_PER_WINDOW);
    }

    const day = new Date().toISOString().slice(0, 10);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      readRequest('/v1/summary', { projectId: PROJECT, from: day, to: day }, READ_KEY),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(429);

    // The same count on a WRITE key is nowhere near its ceiling: ingest keeps the
    // generous number, so a popular app's fleet is not 429'd for being popular.
    resetRateLimiter();
    for (let i = 0; i < READ_LIMIT_PER_WINDOW; i += 1) {
      await checkPreAuthRate(WRITE_KEY, nowMs);
    }
    expect((await post(makeBatch())).status).toBe(202);

    resetRateLimiter();
  });
});
