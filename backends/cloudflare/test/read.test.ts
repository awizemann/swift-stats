// GET /v1/summary and GET /v1/events/top conformance — docs/schema.md §8.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import {
  INSTALLS,
  OTHER_READ_KEY,
  PROJECT,
  READ_KEY,
  WRITE_KEY,
  readRequest,
  resetDatabase,
  seedEvents,
} from './helpers.js';

async function get(path: string, params: Record<string, string>, key: string | null = READ_KEY) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(readRequest(path, params, key), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const S1 = '1786012978-40371852';
const S2 = '1786013999-11112222';
const S3 = '1786099999-33334444';

/**
 * The summary fixture. Hand-computed expectations, from §8.1's definitions:
 *
 * 2026-08-01  install A session S1: app_open, project_opened
 *             install A session S2: app_open
 *             install B session S1: app_open            <- SAME sessionId as A's
 *   opens 3 · sessions 3 · activeInstalls 2 · events 4
 *
 *   The three sessions are (A,S1), (A,S2), (B,S1). A backend that counted
 *   DISTINCT session_id alone would say 2 — that is the discriminating case for
 *   §10's "a sessionId is not globally unique; key on (installId, sessionId)".
 *
 * 2026-08-02  install A session S3: project_opened, project_opened
 *             install A session S3 (debug build): app_open
 *   Excluding debug: opens 0 · sessions 1 · activeInstalls 1 · events 2
 *   Including debug: opens 1 · sessions 1 · activeInstalls 1 · events 3
 *
 * 2026-08-03  nothing at all -> an explicit zero row.
 */
async function seedSummaryFixture(): Promise<void> {
  await seedEvents([
    { day: '2026-08-01', name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1 },
    { day: '2026-08-01', name: 'app_open', installId: INSTALLS.a, sessionId: S2 },
    { day: '2026-08-01', name: 'app_open', installId: INSTALLS.b, sessionId: S1 },

    { day: '2026-08-02', name: 'project_opened', installId: INSTALLS.a, sessionId: S3 },
    { day: '2026-08-02', name: 'project_opened', installId: INSTALLS.a, sessionId: S3 },
    { day: '2026-08-02', name: 'app_open', installId: INSTALLS.a, sessionId: S3, isDebug: true },
  ]);
}

beforeEach(async () => {
  await resetDatabase();
});

describe('read authentication (§8)', () => {
  it('401s a missing read key', async () => {
    expect((await get('/v1/summary', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' }, null)).status).toBe(401);
  });

  it('401s a WRITE key on a read endpoint', async () => {
    // §8: a write key MUST NOT grant reads. The write key ships in the app
    // binary, so this is the assertion that keeps a public key from reading.
    const response = await get(
      '/v1/summary',
      { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' },
      WRITE_KEY,
    );
    expect(response.status).toBe(401);
  });

  it('makes an out-of-scope project indistinguishable from a nonexistent one', async () => {
    // §8 forbids distinguishing them, because the distinction leaks which
    // projects exist. Byte-identical responses is the strongest form of that.
    const outOfScope = await get(
      '/v1/summary',
      { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' },
      OTHER_READ_KEY,
    );
    const nonexistent = await get(
      '/v1/summary',
      { projectId: 'no-such-project-at-all', from: '2026-08-01', to: '2026-08-01' },
      OTHER_READ_KEY,
    );

    expect(outOfScope.status).toBe(401);
    expect(nonexistent.status).toBe(401);
    expect(await outOfScope.text()).toBe(await nonexistent.text());
  });

  it('401s rather than 400s a malformed projectId', async () => {
    // Answering 400 here would let a caller tell "bad syntax" from "not yours",
    // which is a probe for which projects exist.
    const response = await get('/v1/summary', { projectId: 'has spaces', from: '2026-08-01', to: '2026-08-01' });
    expect(response.status).toBe(401);
  });
});

describe('GET /v1/summary (§8.1)', () => {
  it('computes opens, sessions, activeInstalls and events per the §8.1 definitions', async () => {
    await seedSummaryFixture();
    const response = await get('/v1/summary', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-03' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { rows: unknown[]; from: string; to: string; includeDebug: boolean };
    expect(body.includeDebug).toBe(false);
    expect(body.rows).toEqual([
      { date: '2026-08-01', opens: 3, sessions: 3, activeInstalls: 2, events: 4 },
      { date: '2026-08-02', opens: 0, sessions: 1, activeInstalls: 1, events: 2 },
      { date: '2026-08-03', opens: 0, sessions: 0, activeInstalls: 0, events: 0 },
    ]);
  });

  it('keys sessions on (installId, sessionId), not sessionId alone', async () => {
    // Discriminating on its own: install A and install B share sessionId S1 on
    // 2026-08-01, so COUNT(DISTINCT session_id) gives 2 and the correct
    // COUNT(DISTINCT install||session) gives 3.
    await seedSummaryFixture();
    const body = (await (
      await get('/v1/summary', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' })
    ).json()) as { rows: Array<{ sessions: number }> };
    expect(body.rows[0]?.sessions).toBe(3);
  });

  it('includeDebug defaults to false and true changes the answer', async () => {
    await seedSummaryFixture();
    const off = (await (
      await get('/v1/summary', { projectId: PROJECT, from: '2026-08-02', to: '2026-08-02' })
    ).json()) as { rows: Array<{ opens: number; events: number }> };
    const on = (await (
      await get('/v1/summary', { projectId: PROJECT, from: '2026-08-02', to: '2026-08-02', includeDebug: 'true' })
    ).json()) as { rows: Array<{ opens: number; events: number }> };

    expect(off.rows[0]).toMatchObject({ opens: 0, events: 2 });
    expect(on.rows[0]).toMatchObject({ opens: 1, events: 3 });
  });

  it('zero-fills every day in the range and sorts ascending', async () => {
    await seedEvents([{ day: '2026-08-10', name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    const body = (await (
      await get('/v1/summary', { projectId: PROJECT, from: '2026-08-08', to: '2026-08-12' })
    ).json()) as { rows: Array<{ date: string; events: number }> };

    expect(body.rows.map((r) => r.date)).toEqual([
      '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
    ]);
    expect(body.rows.map((r) => r.events)).toEqual([0, 0, 1, 0, 0]);
  });

  it('sees no other project’s events', async () => {
    await seedEvents([
      { day: '2026-08-01', name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: '2026-08-01', name: 'app_open', installId: INSTALLS.b, sessionId: S2, projectId: 'someone-else' },
    ]);
    const body = (await (
      await get('/v1/summary', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' })
    ).json()) as { rows: Array<{ events: number; activeInstalls: number }> };
    expect(body.rows[0]).toMatchObject({ events: 1, activeInstalls: 1 });
  });

  it('clamps a `to` after today and echoes the range actually served', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const body = (await (
      await get('/v1/summary', { projectId: PROJECT, from: today, to: '2099-12-31' })
    ).json()) as { from: string; to: string; rows: Array<{ date: string }> };

    // §8.1: the response never contains a future row, and `from`/`to` echo what
    // was SERVED, not what was asked.
    expect(body.to).toBe(today);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.date).toBe(today);
  });

  it('400s a `to` before `from`', async () => {
    const response = await get('/v1/summary', { projectId: PROJECT, from: '2026-08-05', to: '2026-08-01' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_range' });
  });

  it('400s a span over 400 days with range_too_large', async () => {
    // 401 days inclusive: 2025-01-01 .. 2026-02-05.
    const response = await get('/v1/summary', { projectId: PROJECT, from: '2025-01-01', to: '2026-02-05' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'range_too_large' });
  });

  it('accepts exactly 400 days', async () => {
    // The off-by-one guard on the other side of the boundary: 2025-01-01 ..
    // 2026-02-04 is 400 days inclusive and must be accepted.
    const response = await get('/v1/summary', { projectId: PROJECT, from: '2025-01-01', to: '2026-02-04' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(400);
  });

  it('400s a non-existent calendar day', async () => {
    // `2026-02-30` passes a bare regex and `Date.parse` rolls it over to March.
    const response = await get('/v1/summary', { projectId: PROJECT, from: '2026-02-30', to: '2026-02-30' });
    expect(response.status).toBe(400);
  });

  it('400s a malformed includeDebug', async () => {
    const response = await get('/v1/summary', {
      projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', includeDebug: 'yes',
    });
    expect(response.status).toBe(400);
  });

  it('is safe: a read writes nothing', async () => {
    await seedSummaryFixture();
    const before = await (env as never as { DB: D1Database }).DB.prepare(
      `SELECT COUNT(*) AS n FROM events`,
    ).first<{ n: number }>();
    await get('/v1/summary', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-03' });
    const after = await (env as never as { DB: D1Database }).DB.prepare(
      `SELECT COUNT(*) AS n FROM events`,
    ).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe('GET /v1/events/top without name (§8.2)', () => {
  beforeEach(async () => {
    await seedEvents([
      { day: '2026-08-01', name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: '2026-08-01', name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
      { day: '2026-08-01', name: 'app_open', installId: INSTALLS.b, sessionId: S2 },
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1 },
      // Two names with the SAME count, to pin the documented tiebreak.
      { day: '2026-08-01', name: 'beta_event', installId: INSTALLS.a, sessionId: S1 },
      { day: '2026-08-01', name: 'alpha_event', installId: INSTALLS.a, sessionId: S1 },
    ]);
  });

  it('sorts by count desc, then name ascending', async () => {
    const body = (await (
      await get('/v1/events/top', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01' })
    ).json()) as { rows: Array<{ name: string; count: number; installs: number }>; name: null; limit: number };

    expect(body.name).toBeNull();
    expect(body.limit).toBe(20);
    expect(body.rows).toEqual([
      { name: 'app_open', count: 3, installs: 2 },
      // count 1 each; `alpha_event` < `beta_event` < `project_opened` ascending.
      { name: 'alpha_event', count: 1, installs: 1 },
      { name: 'beta_event', count: 1, installs: 1 },
      { name: 'project_opened', count: 1, installs: 1 },
    ]);
  });

  it('honors limit as a total row cap', async () => {
    const body = (await (
      await get('/v1/events/top', { projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', limit: '2' })
    ).json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('400s a limit outside 1..100 or a non-integer', async () => {
    for (const limit of ['0', '101', '-1', 'abc', '20.0', '2e1', '']) {
      const response = await get('/v1/events/top', {
        projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', limit,
      });
      expect(response.status, `limit=${limit}`).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_limit' });
    }
  });
});

describe('GET /v1/events/top with name (§8.2)', () => {
  beforeEach(async () => {
    await seedEvents([
      // section=analytics ×3 (installs A, A, B)
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'analytics', cached: true } },
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'analytics', cached: false } },
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.b, sessionId: S1, props: { section: 'analytics', cached: true } },
      // section=overview ×1
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'overview' } },
      // section explicitly null ×1
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.b, sessionId: S1, props: { section: null } },
      // section ABSENT ×1, plus a numeric prop that must never be broken down
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.b, sessionId: S1, props: { tile_count: 6 } },
      // no props at all ×1 — also folds into every prop's null row
      { day: '2026-08-01', name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: null },
    ]);
  });

  async function rows(params: Record<string, string> = {}) {
    const body = (await (
      await get('/v1/events/top', {
        projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', name: 'project_opened', ...params,
      })
    ).json()) as { rows: Array<{ prop: string; value: unknown; count: number; installs: number }> };
    return body.rows;
  }

  it('breaks down string props, folding explicit null and absent into one null row', async () => {
    const sections = (await rows()).filter((r) => r.prop === 'section');
    expect(sections).toEqual([
      { prop: 'section', value: 'analytics', count: 3, installs: 2 },
      { prop: 'section', value: 'overview', count: 1, installs: 1 },
      // §8.2: 1 explicit null + 1 absent (the tile_count-only event) + 1 event
      // with no props at all = 3, across installs A and B.
      { prop: 'section', value: null, count: 3, installs: 2 },
    ]);
  });

  it('puts the null row last regardless of its count', async () => {
    // Discriminating: `section`'s null row has count 3, tying the top non-null
    // row. A plain "count desc" sort would put it first.
    const sections = (await rows()).filter((r) => r.prop === 'section');
    expect(sections[sections.length - 1]?.value).toBeNull();
  });

  it('breaks down bool props as JSON booleans', async () => {
    const cached = (await rows()).filter((r) => r.prop === 'cached');
    expect(cached).toEqual([
      { prop: 'cached', value: true, count: 2, installs: 2 },
      { prop: 'cached', value: false, count: 1, installs: 1 },
      { prop: 'cached', value: null, count: 4, installs: 2 },
    ]);
  });

  it('omits numeric props from the breakdown entirely', async () => {
    // §8.2: bucketing is unspecified in v1 and a raw breakdown of a continuous
    // value is a cardinality hazard, so `tile_count` must not appear at all —
    // not even as a null row.
    expect((await rows()).some((r) => r.prop === 'tile_count')).toBe(false);
  });

  it('orders props ascending', async () => {
    const props = [...new Set((await rows()).map((r) => r.prop))];
    expect(props).toEqual(['cached', 'section']);
  });

  it('caps rows PER PROP, not in total', async () => {
    // §8.2: a breakdown of 2 props at limit=1 returns up to 2 rows.
    const capped = await rows({ limit: '1' });
    expect(capped).toHaveLength(2);
    expect(capped.map((r) => r.prop)).toEqual(['cached', 'section']);
  });

  it('returns 200 with empty rows for an unknown name', async () => {
    const response = await get('/v1/events/top', {
      projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', name: 'never_emitted',
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { rows: unknown[] }).rows).toEqual([]);
  });

  it('400s a syntactically invalid name', async () => {
    const response = await get('/v1/events/top', {
      projectId: PROJECT, from: '2026-08-01', to: '2026-08-01', name: 'Not A Name',
    });
    expect(response.status).toBe(400);
  });
});
