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
  resetDatabase,
} from './helpers.js';

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

  it('does not dedupe by (installId, seq)', async () => {
    // §6: a legitimate reinstall restarts `seq` at 0, so two different batches
    // with the same (installId, seq) are two real events.
    await post(makeBatch({ batchId: batchId(9003), events: [makeEvent({ seq: 0 })] }));
    await post(makeBatch({ batchId: batchId(9004), events: [makeEvent({ seq: 0 })] }));
    expect(await eventCount()).toBe(2);
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
    const marker = 'canary_value_that_must_not_come_back';
    const response = await post(makeBatch({ events: [makeEvent({ name: marker.toUpperCase() })] }));
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
    for (const name of ['app_open', 'app_background', 'session_start', 'session_end']) {
      const response = await post(makeBatch({ batchId: batchId(), events: [makeEvent({ name })] }));
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
