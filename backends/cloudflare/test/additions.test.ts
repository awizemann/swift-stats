// The three additive backend features: `keys.last_used_at` (0004), the
// `installs` first-seen table (0005), and per-project `retention_days` (0006).
//
// Every boundary here is derived with the same helpers the Worker uses rather
// than written as a literal date, for the reason rollup.test.ts states: a literal
// agrees with the clock on the day it is written and silently drifts across a
// retention boundary months later.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { runScheduled } from '../src/rollup.js';
import { addDays, clampRetentionDays, rawCutoffDay, today, RAW_RETENTION_DAYS } from '../src/dates.js';
import { KEY_TOUCH_INTERVAL_MS } from '../src/keys.js';
import { firstSeenRows, rawBoundaryDay, resolveRange, totalInstalls } from '../src/lib/queries.js';
import {
  DB,
  INSTALLS,
  OTHER_PROJECT,
  OTHER_WRITE_KEY,
  PROJECT,
  READ_KEY,
  REVOKED_WRITE_KEY,
  WRITE_KEY,
  batchId,
  ingestRequest,
  lastUsedAt,
  makeBatch,
  makeEvent,
  readRequest,
  resetDatabase,
  seedEvents,
  seedInstalls,
  setLastUsed,
  setRetention,
  makeContext,
} from './helpers.js';
import type { Env } from '../src/env.js';

const TODAY = today(new Date());
const NOW = new Date(`${TODAY}T02:10:00.000Z`);
const YESTERDAY = addDays(TODAY, -1);
const S1 = '1786012978-40371852';

const testEnv = env as never as Env;

async function post(body: unknown, key: string = WRITE_KEY): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(ingestRequest(body, { key }), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function getSummary(params: Record<string, string>, key: string = READ_KEY): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(readRequest('/v1/summary', params, key), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Rewind a key's stored `last_used_at` by `ms`, to fake the passage of time. */
async function ageLastUsed(key: string, ms: number): Promise<string> {
  const current = await lastUsedAt(key);
  const aged = new Date(Date.parse(current as string) - ms).toISOString();
  await setLastUsed(key, aged);
  return aged;
}

beforeEach(async () => {
  await resetDatabase();
});

// -----------------------------------------------------------------------------
// 0004 — keys.last_used_at
// -----------------------------------------------------------------------------

describe('keys.last_used_at', () => {
  it('is NULL until the key is used', async () => {
    expect(await lastUsedAt(WRITE_KEY)).toBeNull();
    expect(await lastUsedAt(READ_KEY)).toBeNull();
  });

  it('is set by the first ingest with a write key', async () => {
    const before = Date.now();
    const response = await post(makeBatch());
    expect(response.status).toBe(202);

    const stored = await lastUsedAt(WRITE_KEY);
    expect(stored).not.toBeNull();
    // A well-formed §0 timestamp, not whatever `Date` happened to stringify.
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(stored as string)).toBeGreaterThanOrEqual(before - 1_000);
  });

  it('is NOT rewritten by a second use inside the coalescing window', async () => {
    await post(makeBatch({ batchId: batchId(1) }));
    const first = await lastUsedAt(WRITE_KEY);

    // Several more requests, all within the window. The point of the column is
    // liveness, not a request counter, and D1 bills rows written.
    await post(makeBatch({ batchId: batchId(2) }));
    await post(makeBatch({ batchId: batchId(3) }));

    expect(await lastUsedAt(WRITE_KEY)).toBe(first);
  });

  it('IS rewritten once the stored value is older than the window', async () => {
    await post(makeBatch({ batchId: batchId(4) }));
    const aged = await ageLastUsed(WRITE_KEY, KEY_TOUCH_INTERVAL_MS * 2);
    expect(await lastUsedAt(WRITE_KEY)).toBe(aged);

    await post(makeBatch({ batchId: batchId(5) }));
    const after = await lastUsedAt(WRITE_KEY);
    expect(after).not.toBe(aged);
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(aged));
  });

  it('is set by a read with a read key, and each key tracks its own', async () => {
    await post(makeBatch({ batchId: batchId(6) }));
    const write = await lastUsedAt(WRITE_KEY);

    const response = await getSummary({ projectId: PROJECT, from: YESTERDAY, to: TODAY });
    expect(response.status).toBe(200);

    expect(await lastUsedAt(READ_KEY)).not.toBeNull();
    // The read did not touch the WRITE key.
    expect(await lastUsedAt(WRITE_KEY)).toBe(write);
  });

  it('is never updated for a revoked key', async () => {
    const response = await post(makeBatch(), REVOKED_WRITE_KEY);
    expect(response.status).toBe(401);
    expect(await lastUsedAt(REVOKED_WRITE_KEY)).toBeNull();
  });

  it('is not updated for an unknown key, and the 401 is unchanged', async () => {
    const response = await post(makeBatch(), 'sk_stats_NOT_A_KEY_000000000000000000001');
    expect(response.status).toBe(401);
    const rows = await DB.prepare(`SELECT COUNT(*) AS n FROM keys WHERE last_used_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('freezes at the last live use when a key is revoked afterwards', async () => {
    await post(makeBatch({ batchId: batchId(7) }));
    const used = await lastUsedAt(WRITE_KEY);
    await DB.prepare(`UPDATE keys SET revoked_at = ?1 WHERE last_used_at = ?2`)
      .bind(new Date().toISOString(), used)
      .run();

    const response = await post(makeBatch({ batchId: batchId(8) }));
    expect(response.status).toBe(401);
    expect(await lastUsedAt(WRITE_KEY)).toBe(used);
  });
});

// -----------------------------------------------------------------------------
// 0005 — installs
// -----------------------------------------------------------------------------

describe('installs', () => {
  it('is written at ingest, once per distinct install', async () => {
    await post(
      makeBatch({
        batchId: batchId(10),
        events: [
          makeEvent({ ts: `${TODAY}T10:00:00.000Z`, sessionId: S1 }),
          makeEvent({ ts: `${TODAY}T10:00:01.000Z`, sessionId: S1, seq: 2 }),
          makeEvent({ ts: `${TODAY}T10:00:02.000Z`, sessionId: S1, seq: 3 }),
        ],
      }),
    );

    const rows = await DB.prepare(
      `SELECT install_id AS installId, first_seen_day AS day FROM installs WHERE project_id = ?1`,
    )
      .bind(PROJECT)
      .all<{ installId: string; day: string }>();

    expect(rows.results).toEqual([{ installId: INSTALLS.a, day: TODAY }]);
  });

  it('records the OLDEST bucket day in a batch, not the first event', async () => {
    await post(
      makeBatch({
        batchId: batchId(11),
        events: [
          makeEvent({ ts: `${TODAY}T10:00:00.000Z`, sessionId: S1 }),
          // A queued, older event later in the same batch (§1 permits this).
          makeEvent({ ts: `${YESTERDAY}T10:00:00.000Z`, sessionId: S1, seq: 2 }),
        ],
      }),
    );

    const row = await DB.prepare(
      `SELECT first_seen_day AS day FROM installs WHERE project_id = ?1 AND install_id = ?2`,
    )
      .bind(PROJECT, INSTALLS.a)
      .first<{ day: string }>();
    expect(row?.day).toBe(YESTERDAY);
  });

  it('does not move first_seen_day on a later batch from the same install', async () => {
    await post(
      makeBatch({
        batchId: batchId(12),
        events: [makeEvent({ ts: `${addDays(TODAY, -3)}T10:00:00.000Z`, sessionId: S1 })],
      }),
    );
    await post(
      makeBatch({
        batchId: batchId(13),
        events: [makeEvent({ ts: `${TODAY}T10:00:00.000Z`, sessionId: S1 })],
      }),
    );

    const rows = await DB.prepare(
      `SELECT first_seen_day AS day FROM installs WHERE project_id = ?1`,
    )
      .bind(PROJECT)
      .all<{ day: string }>();
    expect(rows.results).toEqual([{ day: addDays(TODAY, -3) }]);
  });

  it('is scoped per project — the same install in two projects is two rows', async () => {
    await post(makeBatch({ batchId: batchId(14) }), WRITE_KEY);
    await post(makeBatch({ batchId: batchId(15) }), OTHER_WRITE_KEY);

    const rows = await DB.prepare(
      `SELECT project_id AS projectId FROM installs WHERE install_id = ?1 ORDER BY project_id`,
    )
      .bind(INSTALLS.a)
      .all<{ projectId: string }>();
    expect(rows.results.map((r) => r.projectId).sort()).toEqual([OTHER_PROJECT, PROJECT].sort());
  });

  it('is not written when the batch is rejected as a duplicate', async () => {
    const body = makeBatch({ batchId: batchId(16) });
    await post(body);
    await DB.prepare(`DELETE FROM installs`).run();
    // The replay is a 202 (§6), and it must not resurrect the install row from a
    // batch whose events were not written this time either.
    const response = await post(body);
    expect(response.status).toBe(202);
    const n = await DB.prepare(`SELECT COUNT(*) AS n FROM installs`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('SURVIVES the raw purge that deletes its events', async () => {
    const oldDay = addDays(TODAY, -(RAW_RETENTION_DAYS + 30));
    await seedEvents([{ day: oldDay, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    await seedInstalls([{ installId: INSTALLS.a, firstSeenDay: oldDay }]);

    const result = await runScheduled(testEnv, NOW);
    expect(result.deletedEvents).toBe(1);

    const events = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE day = ?1`)
      .bind(oldDay)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);

    const installs = await DB.prepare(
      `SELECT first_seen_day AS day FROM installs WHERE project_id = ?1`,
    )
      .bind(PROJECT)
      .all<{ day: string }>();
    expect(installs.results).toEqual([{ day: oldDay }]);
  });

  it('is removed when its project is deleted', async () => {
    await seedInstalls([
      { installId: INSTALLS.a, firstSeenDay: TODAY },
      { installId: INSTALLS.b, firstSeenDay: TODAY, projectId: OTHER_PROJECT },
    ]);

    await DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(PROJECT).run();

    const rows = await DB.prepare(
      `SELECT project_id AS projectId FROM installs`,
    ).all<{ projectId: string }>();
    expect(rows.results).toEqual([{ projectId: OTHER_PROJECT }]);
  });

  it('is backfilled from existing events by the migration', async () => {
    // `resetDatabase` re-applies every migration against an empty database, so the
    // backfill is exercised here by seeding events and re-running the statement
    // the migration contains, with the same OR IGNORE semantics.
    await seedEvents([
      { day: addDays(TODAY, -5), name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: addDays(TODAY, -2), name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: addDays(TODAY, -1), name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
    ]);
    await DB.prepare(
      `INSERT OR IGNORE INTO installs (project_id, install_id, first_seen_day)
       SELECT project_id, install_id, MIN(day) FROM events GROUP BY project_id, install_id`,
    ).run();

    const rows = await DB.prepare(
      `SELECT install_id AS installId, first_seen_day AS day FROM installs ORDER BY install_id`,
    ).all<{ installId: string; day: string }>();
    expect(rows.results).toEqual([
      { installId: INSTALLS.a, day: addDays(TODAY, -5) },
      { installId: INSTALLS.b, day: addDays(TODAY, -1) },
    ]);
  });
});

describe('firstSeenRows', () => {
  it('counts installs per first-seen day, zero-filled and ascending', async () => {
    await seedInstalls([
      { installId: 'a'.repeat(64), firstSeenDay: addDays(TODAY, -3) },
      { installId: 'c'.repeat(64), firstSeenDay: addDays(TODAY, -3) },
      { installId: 'd'.repeat(64), firstSeenDay: TODAY },
      // Another project's install must not appear.
      { installId: 'e'.repeat(64), firstSeenDay: TODAY, projectId: OTHER_PROJECT },
    ]);

    const rows = await firstSeenRows(DB, PROJECT, addDays(TODAY, -3), TODAY);
    expect(rows).toEqual([
      { date: addDays(TODAY, -3), installs: 2 },
      { date: addDays(TODAY, -2), installs: 0 },
      { date: addDays(TODAY, -1), installs: 0 },
      { date: TODAY, installs: 1 },
    ]);
  });

  it('never returns an install id', async () => {
    await seedInstalls([{ installId: INSTALLS.a, firstSeenDay: TODAY }]);
    const rows = await firstSeenRows(DB, PROJECT, TODAY, TODAY);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(INSTALLS.a);
    expect(Object.keys(rows[0] as object).sort()).toEqual(['date', 'installs']);
  });

  it('reaches back further than raw retention', async () => {
    const ancient = addDays(TODAY, -(RAW_RETENTION_DAYS + 100));
    await seedInstalls([{ installId: INSTALLS.a, firstSeenDay: ancient }]);
    const rows = await firstSeenRows(DB, PROJECT, ancient, ancient);
    expect(rows).toEqual([{ date: ancient, installs: 1 }]);
  });

  it('rejects a malformed, inverted or oversized range with the read contract codes', async () => {
    await expect(firstSeenRows(DB, PROJECT, '2026-02-30', TODAY)).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(firstSeenRows(DB, PROJECT, TODAY, addDays(TODAY, -1))).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(firstSeenRows(DB, PROJECT, addDays(TODAY, -400), TODAY)).rejects.toMatchObject({
      code: 'range_too_large',
    });
  });

  it('totalInstalls counts every install ever, and through a day', async () => {
    await seedInstalls([
      { installId: 'a'.repeat(64), firstSeenDay: addDays(TODAY, -400) },
      { installId: 'b'.repeat(64), firstSeenDay: TODAY },
    ]);
    expect(await totalInstalls(DB, PROJECT)).toBe(2);
    expect(await totalInstalls(DB, PROJECT, addDays(TODAY, -1))).toBe(1);
    expect(await totalInstalls(DB, OTHER_PROJECT)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 0006 — projects.retention_days
// -----------------------------------------------------------------------------

describe('projects.retention_days', () => {
  it('defaults to the documented 90 for every existing project', async () => {
    const rows = await DB.prepare(`SELECT retention_days AS d FROM projects`).all<{ d: number }>();
    expect(rows.results.every((r) => r.d === RAW_RETENTION_DAYS)).toBe(true);
  });

  it('clamps a stored value outside the supported bounds', () => {
    expect(clampRetentionDays(5)).toBe(RAW_RETENTION_DAYS);
    expect(clampRetentionDays(null)).toBe(RAW_RETENTION_DAYS);
    expect(clampRetentionDays(180)).toBe(180);
    expect(clampRetentionDays(10_000)).toBe(400);
  });

  it('keeps a longer-retention project\'s old events while a default project loses them', async () => {
    const day100 = addDays(TODAY, -100);
    await setRetention(PROJECT, 180);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);

    await runScheduled(testEnv, NOW);

    const kept = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?1`)
      .bind(PROJECT)
      .first<{ n: number }>();
    const swept = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?1`)
      .bind(OTHER_PROJECT)
      .first<{ n: number }>();

    expect(kept?.n).toBe(1);
    expect(swept?.n).toBe(0);
  });

  it('rolls a day up before deleting it, per project', async () => {
    const day100 = addDays(TODAY, -100);
    await setRetention(PROJECT, 180);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);

    await runScheduled(testEnv, NOW);

    const rollup = await DB.prepare(
      `SELECT opens FROM daily_rollups WHERE project_id = ?1 AND day = ?2 AND include_debug = 0`,
    )
      .bind(OTHER_PROJECT, day100)
      .first<{ opens: number }>();
    expect(rollup?.opens).toBe(1);
  });

  it('routes the raw/rollup boundary per project', async () => {
    const day100 = addDays(TODAY, -100);
    await setRetention(PROJECT, 180);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);

    // After a sweep: the default project's day-100 rows are gone, the
    // long-retention project's are not. (Before the sweep BOTH read from raw, and
    // that is correct — `rawBoundaryDay` never routes a day to the rollups while
    // its raw rows are still there.)
    await runScheduled(testEnv, NOW);

    // The long-retention project answers day-100 from RAW rows…
    const long = await resolveRange(DB, { projectId: PROJECT, from: day100, to: TODAY }, NOW);
    expect(long.rawFrom).toBe(day100);
    expect(long.rollupTo).toBeNull();

    // …while the default project routes it to the rollups.
    const short = await resolveRange(DB, { projectId: OTHER_PROJECT, from: day100, to: TODAY }, NOW);
    expect(short.rollupTo).toBe(addDays(rawCutoffDay(NOW), -1));
    expect(short.rawFrom).toBe(rawCutoffDay(NOW));
  });

  it('rawBoundaryDay honours the project window without ever reading past its rows', async () => {
    await setRetention(PROJECT, 180);
    // No events at all: the boundary is the project's clock cutoff, not the
    // default's.
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(rawCutoffDay(NOW, 180));
    expect(await rawBoundaryDay(DB, OTHER_PROJECT, NOW)).toBe(rawCutoffDay(NOW));

    // With rows older than that cutoff (not yet swept), the observed boundary wins
    // so a day never reads as zero while its raw rows exist.
    const older = addDays(rawCutoffDay(NOW, 180), -5);
    await seedEvents([{ day: older, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(older);
  });

  it('buckets an implausibly old ts into the PROJECT\'s window at ingest', async () => {
    await setRetention(PROJECT, 180);
    await post(
      makeBatch({
        batchId: batchId(20),
        context: makeContext(),
        events: [makeEvent({ ts: `${addDays(TODAY, -900)}T10:00:00.000Z`, sessionId: S1 })],
      }),
    );

    const row = await DB.prepare(`SELECT day FROM events WHERE project_id = ?1`)
      .bind(PROJECT)
      .first<{ day: string }>();
    // Clamped onto the oldest day THIS project keeps, not the global 90-day one.
    expect(row?.day).toBe(rawCutoffDay(new Date(), 180));
  });

  it('a summary over a long-retention range is served and stays exact', async () => {
    const day100 = addDays(TODAY, -100);
    await setRetention(PROJECT, 180);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
    ]);

    const response = await getSummary({ projectId: PROJECT, from: day100, to: day100 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ date: string; activeInstalls: number }> };
    expect(body.rows).toEqual([
      { date: day100, opens: 2, sessions: 2, activeInstalls: 2, events: 2 },
    ]);
  });
});
