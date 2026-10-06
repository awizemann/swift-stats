// POST /v1/users/erase (schema §8.4) and its lib core, `eraseUserChunk`, plus
// migration 0009 (the `admin` key kind and the `events_user` partial index).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { runScheduled } from '../src/rollup.js';
import { addDays, today } from '../src/dates.js';
import { ADMIN_KEY_PREFIX, hashKey, mintKey } from '../src/keys.js';
import { ADMIN_LIMIT_PER_WINDOW, countAgainst, resetRateLimiter } from '../src/ratelimit.js';
import { eraseUserChunk, MAX_ERASE_CHUNKS } from '../src/lib/index.js';
import {
  ERASE_CLEAR_ROLLUPS_SQL,
  ERASE_DELETE_SQL,
  ERASE_ROLLUP_TABLES,
  ERASE_TOMBSTONE_SQL,
  ERASE_UNLINK_SQL,
  ERASURE_PURGE_SQL,
  ERASURE_TOMBSTONE_MARGIN_DAYS,
  erasedUserModes,
  erasureCutoff,
  purgeExpiredErasures,
} from '../src/lib/erase.js';
import {
  DB,
  INSTALLS,
  MIGRATION_COUNT,
  OTHER_PROJECT,
  OTHER_WRITE_KEY,
  PROJECT,
  READ_KEY,
  WRITE_KEY,
  applyMigrationsFrom,
  ingestRequest,
  lastUsedAt,
  makeBatch,
  makeEvent,
  readRequest,
  resetDatabase,
  seedEvents,
} from './helpers.js';
import type { Env } from '../src/env.js';

const TODAY = today(new Date());
const NOW = new Date(`${TODAY}T02:10:00.000Z`);
const YESTERDAY = addDays(TODAY, -1);
const testEnv = env as never as Env;
const { ADMIN_MJS } = env as unknown as { ADMIN_MJS: string };

const ADMIN_KEY = 'ak_stats_TEST_ADMIN_KEY_0000000000000001';
const OTHER_ADMIN_KEY = 'ak_stats_TEST_ADMIN_KEY_0000000000000002';
const USER = 'c'.repeat(64);
const OTHER_USER = 'd'.repeat(64);

async function seedKey(key: string, project: string, kind: string): Promise<void> {
  await DB.prepare(
    `INSERT INTO keys (key_hash, project_id, kind, label, created_at) VALUES (?1, ?2, ?3, 'test', ?4)`,
  )
    .bind(await hashKey(key), project, kind, NOW.toISOString())
    .run();
}

function eraseRequest(body: unknown, key: string | null = ADMIN_KEY, method = 'POST'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set('x-stats-admin-key', key);
  return new Request('https://stats.example.com/v1/users/erase', {
    method,
    headers,
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

async function send(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function erase(body: unknown, key: string | null = ADMIN_KEY): Promise<Response> {
  return await send(eraseRequest(body, key));
}

/** Events in `projectId` still linked to `userId`. */
async function linked(projectId: string, userId: string): Promise<number> {
  const row = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?1 AND user_id = ?2`)
    .bind(projectId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

async function rollupSnapshot(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const t of ['daily_rollups', 'daily_event_rollups', 'daily_prop_rollups']) {
    out.push((await DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results);
  }
  return out;
}

/**
 * Project A: USER on two installs plus an unidentified event and OTHER_USER.
 * Project B (OTHER_PROJECT): the SAME USER hash — must never be touched.
 */
async function seedFixture(): Promise<void> {
  await seedEvents([
    { day: YESTERDAY, name: 'opened', installId: INSTALLS.a, sessionId: 's1', userId: USER },
    { day: YESTERDAY, name: 'saved', installId: INSTALLS.a, sessionId: 's1', userId: USER, props: { kind: 'x' } },
    { day: YESTERDAY, name: 'opened', installId: INSTALLS.b, sessionId: 's2', userId: USER },
    { day: YESTERDAY, name: 'opened', installId: INSTALLS.a, sessionId: 's0' },
    { day: YESTERDAY, name: 'opened', installId: INSTALLS.b, sessionId: 's3', userId: OTHER_USER },
    { day: YESTERDAY, name: 'opened', installId: INSTALLS.a, sessionId: 's9', userId: USER, projectId: OTHER_PROJECT },
  ]);
}

beforeEach(async () => {
  resetRateLimiter();
  await resetDatabase();
  await seedKey(ADMIN_KEY, PROJECT, 'admin');
  await seedKey(OTHER_ADMIN_KEY, OTHER_PROJECT, 'admin');
  await seedFixture();
});

describe('POST /v1/users/erase — unlink', () => {
  it('nulls only this project\'s rows for this hash, and leaves rollups exact', async () => {
    await runScheduled(testEnv, NOW);
    const rollupsBefore = await rollupSnapshot();
    expect((rollupsBefore[0] as unknown[]).length).toBeGreaterThan(0);
    const eventsBefore = await count(`SELECT COUNT(*) AS n FROM events`);

    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, affected: 3 });

    expect(await linked(PROJECT, USER)).toBe(0);
    // Every row survives: unlink removes the link, not the event.
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(eventsBefore);
    // Another user in the same project, and the same hash in another project.
    expect(await linked(PROJECT, OTHER_USER)).toBe(1);
    expect(await linked(OTHER_PROJECT, USER)).toBe(1);

    // No rollup has a user dimension, so a re-roll of the day is identical.
    await DB.prepare(`DELETE FROM rollup_state`).run();
    await runScheduled(testEnv, NOW);
    expect(await rollupSnapshot()).toEqual(rollupsBefore);
  });

  it('is idempotent: a rerun answers done with nothing affected', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, affected: 0 });
  });
});

describe('POST /v1/users/erase — delete', () => {
  it('removes this project\'s rows for this hash and nothing else', async () => {
    const installsBefore = (await DB.prepare(`SELECT * FROM installs ORDER BY rowid`).all()).results;
    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, affected: 3 });

    expect(await linked(PROJECT, USER)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?1`, PROJECT)).toBe(2);
    expect(await linked(PROJECT, OTHER_USER)).toBe(1);
    expect(await linked(OTHER_PROJECT, USER)).toBe(1);
    // `installs` is never touched (src/lib/erase.ts).
    expect((await DB.prepare(`SELECT * FROM installs ORDER BY rowid`).all()).results).toEqual(installsBefore);

    const again = await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    expect(await again.json()).toEqual({ done: true, affected: 0 });
  });
});

describe('eraseUserChunk — bounded, resumable', () => {
  it('stops at its budget with done:false and resumes to done', async () => {
    // 3 linked rows, 1 row per chunk, 2 chunks per call.
    const first = await eraseUserChunk(DB, PROJECT, USER, 'delete', { chunkRows: 1, maxChunks: 2 });
    expect(first).toEqual({ done: false, affected: 2, chunks: 2 });
    expect(await linked(PROJECT, USER)).toBe(1);

    // Exactly the remainder fills the budget's first chunk; the short second
    // chunk is what proves there is nothing left.
    const second = await eraseUserChunk(DB, PROJECT, USER, 'delete', { chunkRows: 1, maxChunks: 2 });
    expect(second).toEqual({ done: true, affected: 1, chunks: 2 });
    expect(await linked(OTHER_PROJECT, USER)).toBe(1);
  });

  it('a budget that ends on a full chunk reports done on the next, empty call', async () => {
    const first = await eraseUserChunk(DB, PROJECT, USER, 'unlink', { chunkRows: 3, maxChunks: 1 });
    expect(first).toEqual({ done: false, affected: 3, chunks: 1 });
    const second = await eraseUserChunk(DB, PROJECT, USER, 'unlink', { chunkRows: 3, maxChunks: 1 });
    expect(second).toEqual({ done: true, affected: 0, chunks: 1 });
  });

  it('validates the hash and the mode itself, for a direct (dashboard) caller', async () => {
    await expect(eraseUserChunk(DB, PROJECT, USER.toUpperCase(), 'unlink')).rejects.toMatchObject({
      code: 'invalid_user_id',
    });
    await expect(eraseUserChunk(DB, PROJECT, USER, 'purge' as never)).rejects.toMatchObject({
      code: 'invalid_mode',
    });
    expect(await linked(PROJECT, USER)).toBe(3);
  });

  it('every statement it runs finds the user through events_user, not a project scan', async () => {
    const clear = ERASE_CLEAR_ROLLUPS_SQL.replaceAll('{table}', 'daily_rollups');
    for (const sql of [ERASE_UNLINK_SQL, ERASE_DELETE_SQL, clear]) {
      const plan = await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(PROJECT, USER, 10).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join(' | ');
      expect(details, sql).toContain('events_user');
      expect(details, sql).not.toMatch(/SCAN events\b(?! USING)/);
    }
    // The ingest lookup and the tombstone upsert are primary-key probes.
    const lookup = await DB.prepare(
      `EXPLAIN QUERY PLAN SELECT user_id, mode FROM erased_users
        WHERE project_id = ?1 AND erased_at >= ?2 AND user_id IN (SELECT value FROM json_each(?3))`,
    )
      .bind(PROJECT, NOW.toISOString(), JSON.stringify([USER]))
      .all<{ detail: string }>();
    expect(lookup.results.map((r) => r.detail).join(' | ')).toMatch(/SEARCH .*erased_users/);
  });

  it(`does at most MAX_ERASE_CHUNKS (${MAX_ERASE_CHUNKS}) chunks per call by default`, async () => {
    await seedEvents(
      Array.from({ length: 6 }, (_, i) => ({
        day: YESTERDAY,
        name: 'opened',
        installId: INSTALLS.b,
        sessionId: `m${i}`,
        userId: USER,
      })),
    );
    // 9 linked rows, 1 per chunk: the default budget stops at 4.
    const first = await eraseUserChunk(DB, PROJECT, USER, 'unlink', { chunkRows: 1 });
    expect(MAX_ERASE_CHUNKS).toBe(4);
    expect(first).toEqual({ done: false, affected: 4, chunks: 4 });
  });
});

describe('delete mode and rollups', () => {
  it('clears every rollup of a day the delete empties, and keeps days with other rows', async () => {
    const lonely = addDays(TODAY, -2);
    await seedEvents([
      { day: lonely, name: 'opened', installId: INSTALLS.a, sessionId: 's7', userId: USER },
      { day: lonely, name: 'opened', installId: INSTALLS.a, sessionId: 's7', userId: USER, isDebug: true },
    ]);
    await runScheduled(testEnv, NOW);
    const rows = async (table: string, day: string) =>
      count(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?1 AND day = ?2`, PROJECT, day);
    expect(await rows('daily_rollups', lonely)).toBe(2); // both include_debug variants
    expect(await rows('daily_event_rollups', lonely)).toBeGreaterThan(0);
    const yesterdayBefore = await rows('daily_rollups', YESTERDAY);
    expect(yesterdayBefore).toBeGreaterThan(0);

    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    expect(await res.json()).toEqual({ done: true, affected: 5 });

    for (const table of ERASE_ROLLUP_TABLES) expect(await rows(table, lonely), table).toBe(0);
    // YESTERDAY still has other rows: its rollup waits for a re-roll.
    expect(await rows('daily_rollups', YESTERDAY)).toBe(yesterdayBefore);
    // The other project's rollups are untouched.
    expect(await count(`SELECT COUNT(*) AS n FROM daily_rollups WHERE project_id = ?1`, OTHER_PROJECT)).toBeGreaterThan(0);
  });

  it('unlink never touches a rollup', async () => {
    await runScheduled(testEnv, NOW);
    const before = await rollupSnapshot();
    await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    expect(await rollupSnapshot()).toEqual(before);
  });
});

describe('the erase tombstone (late-arriving events)', () => {
  const lateBatch = () =>
    makeBatch({
      events: [
        makeEvent({ seq: 900, userId: USER }),
        makeEvent({ seq: 901, userId: OTHER_USER }),
        makeEvent({ seq: 902 }),
      ],
    });
  const stored = async (seq: number, projectId = PROJECT) =>
    await DB.prepare(`SELECT user_id AS u FROM events WHERE project_id = ?1 AND seq = ?2`)
      .bind(projectId, seq)
      .first<{ u: string | null }>();

  it('after unlink, a late event for the hash is stored unlinked; other hashes keep theirs', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    const res = await send(ingestRequest(lateBatch()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 3 });
    expect(await stored(900)).toEqual({ u: null });
    expect(await stored(901)).toEqual({ u: OTHER_USER });
    expect(await stored(902)).toEqual({ u: null });
    expect(await linked(PROJECT, USER)).toBe(0);
  });

  it('after delete, a late event for the hash is dropped but still acknowledged', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    const batch = lateBatch();
    const res = await send(ingestRequest(batch));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 3 });
    expect(await stored(900)).toBeNull();
    expect(await stored(901)).toEqual({ u: OTHER_USER });
    expect(await stored(902)).not.toBeNull();
    // A retry of the same batch is still a §6 duplicate.
    const again = await send(ingestRequest(batch));
    expect(await again.json()).toEqual({ accepted: 3, duplicate: true });
  });

  it('a batch whose every event is erased is acknowledged and stores nothing', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    const res = await send(ingestRequest(makeBatch({ events: [makeEvent({ seq: 950, userId: USER })] })));
    expect(res.status).toBe(202);
    expect(await stored(950)).toBeNull();
  });

  it('is per project: the same hash in another project still links', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    const res = await send(ingestRequest(lateBatch(), { key: OTHER_WRITE_KEY }));
    expect(res.status).toBe(202);
    expect(await stored(900, OTHER_PROJECT)).toEqual({ u: USER });
  });

  it('delete is sticky over a later unlink', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    const row = await DB.prepare(`SELECT mode FROM erased_users WHERE project_id = ?1 AND user_id = ?2`)
      .bind(PROJECT, USER)
      .first<{ mode: string }>();
    expect(row).toEqual({ mode: 'delete' });
  });

  it('expires after the project window plus the margin: ignored by ingest, purged nightly', async () => {
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    await erase({ projectId: OTHER_PROJECT, userId: USER, mode: 'delete' }, OTHER_ADMIN_KEY);
    const ttlDays = 90 + ERASURE_TOMBSTONE_MARGIN_DAYS;
    const expired = new Date(Date.now() - (ttlDays + 1) * 86_400_000).toISOString();
    await DB.prepare(`UPDATE erased_users SET erased_at = ?2 WHERE project_id = ?1`).bind(PROJECT, expired).run();

    // Expired: ingest links again, even before any purge has run.
    await send(ingestRequest(lateBatch()));
    expect(await stored(900)).toEqual({ u: USER });

    // A live tombstone just inside the bound is not purged; the expired one is.
    await DB.prepare(`UPDATE erased_users SET erased_at = ?2 WHERE project_id = ?1`)
      .bind(OTHER_PROJECT, new Date(Date.now() - (ttlDays - 1) * 86_400_000).toISOString())
      .run();
    await runScheduled(testEnv, new Date());
    const left = (await DB.prepare(`SELECT project_id AS p FROM erased_users`).all<{ p: string }>()).results;
    expect(left).toEqual([{ p: OTHER_PROJECT }]);
    expect(await purgeExpiredErasures(DB, new Date())).toBe(0);
  });

  it('a project with a longer window keeps its tombstone longer', async () => {
    await DB.prepare(`UPDATE projects SET retention_days = 400 WHERE id = ?1`).bind(PROJECT).run();
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await DB.prepare(`UPDATE erased_users SET erased_at = ?1`).bind(at).run();
    expect(await purgeExpiredErasures(DB, new Date())).toBe(0);
    await send(ingestRequest(lateBatch()));
    expect(await stored(900)).toBeNull();
  });
});

describe('admin.mjs delete-user ↔ src/lib/erase.ts', () => {
  const literal = (name: string): string => {
    const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(ADMIN_MJS);
    expect(match, `${name} not found in admin.mjs`).not.toBeNull();
    return match?.[1] ?? '';
  };

  it('the CLI carries the Worker statements verbatim', () => {
    const chunkIds = literal('CHUNK_IDS');
    const evaluate = (name: string) => literal(name).replaceAll('${CHUNK_IDS}', chunkIds);
    expect(evaluate('ERASE_TOMBSTONE_SQL')).toBe(ERASE_TOMBSTONE_SQL);
    expect(evaluate('ERASE_UNLINK_SQL')).toBe(ERASE_UNLINK_SQL);
    expect(evaluate('ERASE_DELETE_SQL')).toBe(ERASE_DELETE_SQL);
    expect(evaluate('ERASE_CLEAR_ROLLUPS_SQL')).toBe(ERASE_CLEAR_ROLLUPS_SQL);
    for (const table of ERASE_ROLLUP_TABLES) expect(ADMIN_MJS).toContain(`'${table}'`);
  });

  it('requires an explicit mode and writes the tombstone', () => {
    const command = ADMIN_MJS.slice(ADMIN_MJS.indexOf("case 'delete-user'"));
    const body = command.slice(0, command.indexOf("\n  default:"));
    expect(body).toContain('pass exactly one of --unlink or --delete');
    expect(body).toContain('unknown flag for delete-user');
    expect(body).toContain('executeQuiet(tombstoneSql)');
  });
});

describe('POST /v1/users/erase — rate limit and key liveness', () => {
  it('is limited per admin key BEFORE auth: an unknown key gets 429, not 401', async () => {
    const key = 'ak_stats_NOT_A_REAL_KEY_000000000000000';
    const bucket = `admin:key:${await hashKey(key)}`;
    for (let i = 0; i < ADMIN_LIMIT_PER_WINDOW; i += 1) countAgainst(bucket, Date.now(), ADMIN_LIMIT_PER_WINDOW);
    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'delete' }, key);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    // Its own bucket: the same key on a read endpoint is still answered (401).
    const read = await send(readRequest('/v1/summary', { projectId: PROJECT, from: YESTERDAY, to: TODAY }, key));
    expect(read.status).toBe(401);
  });

  it('records last_used_at for an admin key', async () => {
    expect(await lastUsedAt(ADMIN_KEY)).toBeNull();
    await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' });
    expect(await lastUsedAt(ADMIN_KEY)).not.toBeNull();
  });
});

describe('POST /v1/users/erase — keys (§8: one kind, one family)', () => {
  it('write and read keys 401 on erase, byte-identical to an unknown key', async () => {
    const body = { projectId: PROJECT, userId: USER, mode: 'delete' };
    const unknown = await erase(body, 'ak_stats_NOT_A_REAL_KEY_000000000000000');
    const unknownText = await unknown.text();
    expect(unknown.status).toBe(401);
    for (const key of [WRITE_KEY, READ_KEY, null]) {
      const res = await erase(body, key);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(unknownText);
    }
    expect(await linked(PROJECT, USER)).toBe(3);
  });

  it('another project\'s admin key and a malformed projectId are the same 401', async () => {
    const reference = await (await erase({ projectId: PROJECT, userId: USER, mode: 'delete' }, WRITE_KEY)).text();
    for (const [body, key] of [
      [{ projectId: PROJECT, userId: USER, mode: 'delete' }, OTHER_ADMIN_KEY],
      [{ projectId: 'no such project', userId: USER, mode: 'delete' }, ADMIN_KEY],
      [{ userId: USER, mode: 'delete' }, ADMIN_KEY],
      // Out of scope AND an invalid userId: still the 401, never the 400.
      [{ projectId: OTHER_PROJECT, userId: 'nope', mode: 'delete' }, ADMIN_KEY],
    ] as const) {
      const res = await erase(body, key);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(reference);
    }
    expect(await linked(PROJECT, USER)).toBe(3);
    expect(await linked(OTHER_PROJECT, USER)).toBe(1);
  });

  it('an admin key 401s on ingest and on both read endpoints', async () => {
    const ingest = await send(ingestRequest(makeBatch(), { key: ADMIN_KEY }));
    expect(ingest.status).toBe(401);
    const params = { projectId: PROJECT, from: YESTERDAY, to: TODAY };
    expect((await send(readRequest('/v1/summary', params, ADMIN_KEY))).status).toBe(401);
    expect((await send(readRequest('/v1/events/top', params, ADMIN_KEY))).status).toBe(401);
  });

  it('a revoked admin key 401s', async () => {
    await DB.prepare(`UPDATE keys SET revoked_at = ?2 WHERE key_hash = ?1`)
      .bind(await hashKey(ADMIN_KEY), NOW.toISOString())
      .run();
    expect((await erase({ projectId: PROJECT, userId: USER, mode: 'unlink' })).status).toBe(401);
  });

  it('mints admin keys in the shared key format with the ak_stats prefix', async () => {
    const { key, hash } = await mintKey('admin');
    expect(key).toMatch(new RegExp(`^${ADMIN_KEY_PREFIX}_[A-Za-z0-9_-]{43}$`));
    expect(hash).toBe(await hashKey(key));
  });
});

describe('POST /v1/users/erase — validation', () => {
  it.each([
    [{ projectId: PROJECT, userId: USER }, 'invalid_mode'],
    [{ projectId: PROJECT, userId: USER, mode: 'purge' }, 'invalid_mode'],
    [{ projectId: PROJECT, userId: USER, mode: null }, 'invalid_mode'],
    [{ projectId: PROJECT, userId: 'user@example.com', mode: 'delete' }, 'invalid_user_id'],
    [{ projectId: PROJECT, userId: USER.toUpperCase(), mode: 'delete' }, 'invalid_user_id'],
    [{ projectId: PROJECT, userId: USER.slice(1), mode: 'delete' }, 'invalid_user_id'],
    [{ projectId: PROJECT, mode: 'delete' }, 'invalid_user_id'],
    [[1, 2], 'bad_request'],
  ])('400 for %j', async (body, code) => {
    const res = await erase(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(code);
    expect(await linked(PROJECT, USER)).toBe(3);
  });

  it('400 bad_json for an unparseable body, 405 for GET', async () => {
    const bad = await erase('{not json');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('bad_json');
    const get = await send(eraseRequest(null, ADMIN_KEY, 'GET'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('413 for an oversized body', async () => {
    const res = await erase({ projectId: PROJECT, userId: USER, mode: 'delete', pad: 'x'.repeat(5_000) });
    expect(res.status).toBe(413);
  });
});

describe('migration 0009', () => {
  it('preserves every existing key and only then accepts the admin kind', async () => {
    await resetDatabase({ migrations: MIGRATION_COUNT - 1 });
    await DB.prepare(`UPDATE keys SET last_used_at = ?1 WHERE kind = 'read'`).bind(NOW.toISOString()).run();
    const before = (await DB.prepare(`SELECT * FROM keys ORDER BY key_hash`).all()).results;
    expect(before.length).toBeGreaterThan(0);
    // 0008's schema refuses the new kind…
    await expect(seedKey(ADMIN_KEY, PROJECT, 'admin')).rejects.toThrow();

    await applyMigrationsFrom(MIGRATION_COUNT - 1);

    // …every row comes through verbatim, columns and order included…
    expect((await DB.prepare(`SELECT * FROM keys ORDER BY key_hash`).all()).results).toEqual(before);
    const indexes = (
      await DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'keys'`).all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
    expect(indexes).toContain('keys_by_project');
    // …the cascade still holds…
    const sql = await DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'keys'`).first<{ sql: string }>();
    expect(sql?.sql).toMatch(/REFERENCES projects\(id\) ON DELETE CASCADE/);
    // …the old keys still work, and an admin key can now be stored.
    expect((await send(ingestRequest(makeBatch(), { key: WRITE_KEY }))).status).toBe(202);
    await seedKey(ADMIN_KEY, PROJECT, 'admin');
    await expect(seedKey('xk_stats_BAD_KIND_00000000000000000000', PROJECT, 'owner')).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// Second audit: the SQL-side guard, the in-transaction rollup clears, bounds.
// -----------------------------------------------------------------------------

const LOOKUP_SQL = 'SELECT user_id AS userId, mode FROM erased_users';

/** `testEnv` with `prepare` observed, and seams on the ingest tombstone lookup. */
function seamEnv(opts: {
  seen?: string[];
  failLookup?: boolean;
  afterLookup?: () => Promise<void>;
}): Env {
  const db = new Proxy(DB, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          opts.seen?.push(sql);
          const st = target.prepare(sql);
          if (!sql.includes(LOOKUP_SQL)) return st;
          if (opts.failLookup === true) throw new Error('D1_ERROR: Network connection lost.');
          return {
            bind: (...args: unknown[]) => {
              const bound = st.bind(...args);
              return {
                all: async () => {
                  const result = await bound.all();
                  await opts.afterLookup?.();
                  return result;
                },
              };
            },
          };
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { DB: db } as unknown as Env;
}

async function sendWith(e: Env, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, e as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seq(n: number, projectId = PROJECT): Promise<{ u: string | null } | null> {
  return await DB.prepare(`SELECT user_id AS u FROM events WHERE project_id = ?1 AND seq = ?2`)
    .bind(projectId, n)
    .first<{ u: string | null }>();
}

async function tombstone(mode: 'unlink' | 'delete', at: string, projectId = PROJECT): Promise<void> {
  await DB.prepare(ERASE_TOMBSTONE_SQL).bind(projectId, USER, mode, at).run();
}

describe('ingest: the tombstone guard', () => {
  it('a batch with no userId issues no tombstone query at all', async () => {
    const seen: string[] = [];
    const res = await sendWith(seamEnv({ seen }), ingestRequest(makeBatch({ events: [makeEvent({ seq: 700 })] })));
    expect(res.status).toBe(202);
    // No lookup. (The guarded insert is PREPARED with the plain one — preparing
    // is local, not a query — but an event without a userId binds the plain one.)
    expect(seen.some((sql) => sql.includes(LOOKUP_SQL))).toBe(false);
    expect(await seq(700)).toEqual({ u: null });
  });

  it('a batch with a userId issues exactly one lookup', async () => {
    const seen: string[] = [];
    await sendWith(
      seamEnv({ seen }),
      ingestRequest(makeBatch({ events: [makeEvent({ seq: 701, userId: USER }), makeEvent({ seq: 702, userId: OTHER_USER })] })),
    );
    expect(seen.filter((sql) => sql.includes(LOOKUP_SQL))).toHaveLength(1);
  });

  it('a failed lookup is a 503 with Retry-After, and nothing is stored', async () => {
    const res = await sendWith(
      seamEnv({ failLookup: true }),
      ingestRequest(makeBatch({ events: [makeEvent({ seq: 703, userId: USER })] })),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await seq(703)).toBeNull();
  });

  it.each(['unlink', 'delete'] as const)(
    'an erase (%s) landing between the lookup and the batch still wins',
    async (mode) => {
      const e = seamEnv({ afterLookup: () => tombstone(mode, new Date().toISOString()) });
      const res = await sendWith(
        e,
        ingestRequest(makeBatch({ events: [makeEvent({ seq: 710, userId: USER }), makeEvent({ seq: 711, userId: OTHER_USER })] })),
      );
      expect(res.status).toBe(202);
      expect(await seq(710)).toEqual(mode === 'unlink' ? { u: null } : null);
      expect(await seq(711)).toEqual({ u: OTHER_USER });
    },
  );

  it('a fully dropped batch writes no installs row and logs no dedupe', async () => {
    const fresh = 'e'.repeat(64);
    await erase({ projectId: PROJECT, userId: USER, mode: 'delete' });
    const log = vi.spyOn(console, 'log');
    try {
      const res = await send(
        ingestRequest(makeBatch({ events: [makeEvent({ seq: 720, userId: USER, installId: fresh })] })),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: 1 });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('events_deduped'))).toBe(false);
      expect(lines.some((l) => l.includes('events_erased_on_ingest'))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(await count(`SELECT COUNT(*) AS n FROM installs WHERE install_id = ?1`, fresh)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE install_id = ?1`, fresh)).toBe(0);
  });
});

describe('delete: rollup clears inside the transaction', () => {
  const D2 = addDays(TODAY, -2);
  const D3 = addDays(TODAY, -3);
  const rollupRows = async (day: string) => {
    let n = 0;
    for (const t of ERASE_ROLLUP_TABLES) {
      n += await count(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?1 AND day = ?2`, PROJECT, day);
    }
    return n;
  };

  it('concurrent chunks clear exactly the days they empty', async () => {
    await seedEvents([
      { day: D2, name: 'opened', installId: INSTALLS.a, sessionId: 'p1', userId: USER },
      { day: D2, name: 'saved', installId: INSTALLS.a, sessionId: 'p1', userId: USER },
      { day: D2, name: 'opened', installId: INSTALLS.a, sessionId: 'p2', userId: USER, isDebug: true },
      { day: D3, name: 'opened', installId: INSTALLS.a, sessionId: 'p3', userId: USER },
      // D3 also holds ANOTHER install's debug-only row: it must keep its rollups.
      { day: D3, name: 'opened', installId: INSTALLS.b, sessionId: 'p4', isDebug: true },
    ]);
    await runScheduled(testEnv, NOW);
    expect(await rollupRows(D2)).toBeGreaterThan(0);
    const d3Before = await rollupRows(D3);
    const yBefore = await rollupRows(YESTERDAY);
    expect(d3Before).toBeGreaterThan(0);

    const opts = { chunkRows: 1, maxChunks: 20 };
    await Promise.all([
      eraseUserChunk(DB, PROJECT, USER, 'delete', opts),
      eraseUserChunk(DB, PROJECT, USER, 'delete', opts),
    ]);
    expect(await linked(PROJECT, USER)).toBe(0);
    expect(await rollupRows(D2)).toBe(0);
    expect(await rollupRows(D3)).toBe(d3Before);
    expect(await rollupRows(YESTERDAY)).toBe(yBefore);
  });

  it('never clears a day below the project\'s raw_complete_from', async () => {
    await seedEvents([{ day: D3, name: 'opened', installId: INSTALLS.a, sessionId: 'q1', userId: USER }]);
    await runScheduled(testEnv, NOW);
    const before = await rollupRows(D3);
    expect(before).toBeGreaterThan(0);
    await DB.prepare(`UPDATE projects SET raw_complete_from = ?2 WHERE id = ?1`).bind(PROJECT, D2).run();

    await eraseUserChunk(DB, PROJECT, USER, 'delete');
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?1 AND day = ?2`, PROJECT, D3)).toBe(0);
    expect(await rollupRows(D3)).toBe(before);
  });
});

describe('tombstone bounds, exactly', () => {
  it('is live at exactly the cutoff and expired 1 ms before it, for ingest and the purge alike', async () => {
    const now = new Date('2026-10-05T02:10:00.000Z');
    const cutoff = erasureCutoff(90, now);
    expect(Date.parse(cutoff)).toBe(now.getTime() - (90 + ERASURE_TOMBSTONE_MARGIN_DAYS) * 86_400_000);

    await tombstone('delete', cutoff);
    expect((await erasedUserModes(DB, PROJECT, [USER], 90, now)).get(USER)).toBe('delete');
    expect(await purgeExpiredErasures(DB, now)).toBe(0);

    const older = new Date(Date.parse(cutoff) - 1).toISOString();
    await DB.prepare(`UPDATE erased_users SET erased_at = ?1`).bind(older).run();
    expect((await erasedUserModes(DB, PROJECT, [USER], 90, now)).size).toBe(0);
    expect(await purgeExpiredErasures(DB, now)).toBe(1);
  });

  it('a 400-day project\'s tombstone is purged once ITS bound passes, not before', async () => {
    await DB.prepare(`UPDATE projects SET retention_days = 400 WHERE id = ?1`).bind(PROJECT).run();
    const now = new Date();
    const day = 86_400_000;
    await tombstone('delete', new Date(now.getTime() - 429 * day).toISOString());
    expect(await purgeExpiredErasures(DB, now)).toBe(0);
    await DB.prepare(`UPDATE erased_users SET erased_at = ?1`)
      .bind(new Date(now.getTime() - 431 * day).toISOString())
      .run();
    await runScheduled(testEnv, now);
    expect(await count(`SELECT COUNT(*) AS n FROM erased_users`)).toBe(0);
  });

  it('the purge reads a time range, not every tombstone', async () => {
    const plan = await DB.prepare(`EXPLAIN QUERY PLAN ${ERASURE_PURGE_SQL}`)
      .bind(NOW.toISOString())
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' | ')).toContain('erased_users_by_time');
  });
});
