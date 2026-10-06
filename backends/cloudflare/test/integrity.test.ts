// Cross-project integrity of the scheduled job and the read boundary.
//
// Every case here is a scenario where one project's state — its retention
// window, a failed delete, its own deletion — reached into ANOTHER project's
// history, or where a day's history was answered from the wrong store. The
// rollups are kept indefinitely and raw rows are not, so each of these was a
// permanent loss once the night it happened had passed, not a transient error.
//
// As in rollup.test.ts and additions.test.ts, every boundary is derived from the
// same helpers the Worker uses, never written as a literal date.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import {
  DEFAULT_QUERY_BUDGET,
  MIN_QUERY_BUDGET,
  TAIL_QUERIES,
  runScheduled,
  rollupStatements,
  sweepDaysCap,
} from '../src/rollup.js';
import { setProjectRetention } from '../src/retention.js';
import { addDays, rawCutoffDay, today } from '../src/dates.js';
import { MAX_BREAKDOWN_PROPS, propBreakdown, rawBoundaryDay, summary } from '../src/lib/queries.js';
import {
  checkPreAuthRate,
  PRE_AUTH_LIMIT_PER_WINDOW,
  READ_LIMIT_PER_WINDOW,
  resetRateLimiter,
} from '../src/ratelimit.js';
import {
  DB,
  INSTALLS,
  OTHER_PROJECT,
  OTHER_WRITE_KEY,
  PROJECT,
  WRITE_KEY,
  applyMigrationsFrom,
  batchId,
  ingestRequest,
  makeBatch,
  makeEvent,
  resetDatabase,
  seedEvents,
  setRetention,
} from './helpers.js';
import type { Env } from '../src/env.js';

const TODAY = today(new Date());
const NOW = new Date(`${TODAY}T02:10:00.000Z`);
const YESTERDAY = addDays(TODAY, -1);
const S1 = '1786012978-40371852';
const S2 = '1786013999-11112222';

const testEnv = env as never as Env;

/** 0-based index of 0008_raw_tables_cascade.sql in filename order. */
const MIGRATION_0008 = 7;

/** `NOW` shifted by whole days, keeping the 02:10 cron time. */
const nightOf = (deltaDays: number): Date => new Date(NOW.getTime() + deltaDays * 86_400_000);

async function post(body: unknown, key: string = WRITE_KEY): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(ingestRequest(body, { key }), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function rollupEvents(projectId: string, day: string): Promise<number | null> {
  const row = await DB.prepare(
    `SELECT events FROM daily_rollups WHERE project_id = ?1 AND day = ?2 AND include_debug = 0`,
  )
    .bind(projectId, day)
    .first<{ events: number }>();
  return row?.events ?? null;
}

async function rawCount(projectId: string, day?: string): Promise<number> {
  const row = await DB.prepare(
    day === undefined
      ? `SELECT COUNT(*) AS n FROM events WHERE project_id = ?1`
      : `SELECT COUNT(*) AS n FROM events WHERE project_id = ?1 AND day = ?2`,
  )
    .bind(...(day === undefined ? [projectId] : [projectId, day]))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Make every DELETE of `projectId`'s raw rows throw, as a D1 fault would. */
async function failDeletesFor(projectId: string): Promise<void> {
  await DB.prepare(
    `CREATE TRIGGER fail_delete_${projectId.replace(/[^a-z]/g, '_')}
       BEFORE DELETE ON events WHEN old.project_id = '${projectId}'
       BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`,
  ).run();
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimiter();
});

// -----------------------------------------------------------------------------
// 1. Re-rolling a day for one project must not touch another project's rollup
// -----------------------------------------------------------------------------

describe('the expiring-day re-roll is scoped to the project that is expiring it', () => {
  it('mixed retention: a 180-day project expiring a day leaves a 90-day project’s rollup intact', async () => {
    // Day X expires for the 90-day project 90 nights before it expires for the
    // 180-day one. On the first of those nights the default project's raw rows are
    // rolled and removed; on the second, the long project's are. The old job
    // re-rolled X across EVERY project on that second night — DELETE all of day
    // X's rollups, re-INSERT from raw — and the default project no longer had any
    // raw rows for X, so its history for that day was replaced by nothing.
    await setRetention(PROJECT, 180);
    const dayX = addDays(rawCutoffDay(NOW, 180), -1);
    await seedEvents([
      { day: dayX, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: dayX, name: 'app_open', installId: INSTALLS.b, sessionId: S2, projectId: OTHER_PROJECT },
      { day: dayX, name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: OTHER_PROJECT },
    ]);

    // The night the 90-day project expires X.
    await runScheduled(testEnv, nightOf(-90));
    expect(await rawCount(OTHER_PROJECT, dayX)).toBe(0);
    expect(await rawCount(PROJECT, dayX)).toBe(1);
    expect(await rollupEvents(OTHER_PROJECT, dayX)).toBe(2);

    // The night the 180-day project expires it.
    await runScheduled(testEnv, NOW);
    expect(await rawCount(PROJECT, dayX)).toBe(0);
    expect(await rollupEvents(PROJECT, dayX)).toBe(1);
    expect(await rollupEvents(OTHER_PROJECT, dayX)).toBe(2);
  });

  it('set-retention 180 → 90 expires a backlog without touching a neighbour', async () => {
    const day100 = addDays(TODAY, -100);
    await setRetention(PROJECT, 180);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);
    await runScheduled(testEnv, NOW);
    expect(await rawCount(OTHER_PROJECT, day100)).toBe(0);
    expect(await rollupEvents(OTHER_PROJECT, day100)).toBe(1);

    await setRetention(PROJECT, 90);
    await runScheduled(testEnv, NOW);

    expect(await rawCount(PROJECT, day100)).toBe(0);
    expect(await rollupEvents(PROJECT, day100)).toBe(1);
    expect(await rollupEvents(OTHER_PROJECT, day100)).toBe(1);
  });

  it('a project whose delete failed last night cannot wipe its neighbour tonight', async () => {
    // Night 1: both projects' copies of `doomed` are rolled; PROJECT's raw rows
    // are deleted, OTHER_PROJECT's delete throws. Night 2: `doomed` still has
    // raw rows (OTHER_PROJECT's) and is re-rolled — which must not reach
    // PROJECT, whose raw rows for that day are gone for good.
    const doomed = addDays(rawCutoffDay(NOW), -1);
    await seedEvents([
      { day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: doomed, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);
    await failDeletesFor(OTHER_PROJECT);

    await runScheduled(testEnv, NOW);
    expect(await rawCount(PROJECT, doomed)).toBe(0);
    expect(await rawCount(OTHER_PROJECT, doomed)).toBe(1);
    expect(await rollupEvents(PROJECT, doomed)).toBe(1);

    await runScheduled(testEnv, nightOf(1));
    expect(await rollupEvents(PROJECT, doomed)).toBe(1);
    // OTHER_PROJECT's roll and delete are one batch, so its failing delete took
    // its roll with it: no rollup yet, and — the part that matters — its raw
    // rows are all still there to roll from once the fault clears.
    expect(await rawCount(OTHER_PROJECT, doomed)).toBe(1);
  });

  it('one project’s failed sweep does not skip the projects after it', async () => {
    // `projects` is read in insertion order, so PROJECT is swept first. Its
    // failure used to abort the whole delete loop.
    const doomed = addDays(rawCutoffDay(NOW), -1);
    await seedEvents([
      { day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: doomed, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);
    await failDeletesFor(PROJECT);

    const result = await runScheduled(testEnv, NOW);
    expect(await rawCount(PROJECT, doomed)).toBe(1);
    expect(await rawCount(OTHER_PROJECT, doomed)).toBe(0);
    expect(result.deletedEvents).toBe(1);
  });

  it('rollupStatements writes only the project it is given', async () => {
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);
    await DB.batch(rollupStatements(testEnv, YESTERDAY, NOW.toISOString(), PROJECT));
    expect(await rollupEvents(PROJECT, YESTERDAY)).toBe(1);
    expect(await rollupEvents(OTHER_PROJECT, YESTERDAY)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 2. Raw tables are owned by their project (migration 0008)
// -----------------------------------------------------------------------------

describe('events, batches and batch_context cascade with their project (0008)', () => {
  it('deleting a project removes its raw rows, and the job keeps working for everyone else', async () => {
    expect((await post(makeBatch({ batchId: batchId(7001) }), OTHER_WRITE_KEY)).status).toBe(202);
    expect((await post(makeBatch({ batchId: batchId(7002) }))).status).toBe(202);

    await DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(OTHER_PROJECT).run();

    for (const table of ['events', 'batches', 'batch_context', 'installs']) {
      const row = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?1`)
        .bind(OTHER_PROJECT)
        .first<{ n: number }>();
      expect(row?.n, table).toBe(0);
      const kept = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?1`)
        .bind(PROJECT)
        .first<{ n: number }>();
      expect(kept?.n, table).toBe(1);
    }

    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S2 }]);
    const result = await runScheduled(testEnv, NOW);
    expect(result.rolled).toHaveLength(4);
    expect(await rollupEvents(PROJECT, YESTERDAY)).toBe(1);
  });

  it('rebuilds the raw tables preserving rows, ids, STRICT and every index, and drops orphans', async () => {
    // The state a pre-0008 deployment can be in: a project deleted, its raw rows
    // left behind because nothing referenced `projects`.
    await resetDatabase({ migrations: MIGRATION_0008 });
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: 'ghost' },
    ]);
    await DB.prepare(
      `INSERT INTO batches (batch_id, project_id, received_at, event_count) VALUES ('X', 'ghost', ?1, 1)`,
    )
      .bind(NOW.toISOString())
      .run();
    const before = await DB.prepare(`SELECT id, project_id FROM events ORDER BY id`).all<{
      id: number;
      project_id: string;
    }>();

    await applyMigrationsFrom(MIGRATION_0008);

    const after = await DB.prepare(`SELECT id, project_id FROM events ORDER BY id`).all<{
      id: number;
      project_id: string;
    }>();
    expect(after.results).toEqual(before.results.filter((r) => r.project_id !== 'ghost'));
    const ghostBatches = await DB.prepare(`SELECT COUNT(*) AS n FROM batches WHERE project_id = 'ghost'`)
      .first<{ n: number }>();
    expect(ghostBatches?.n).toBe(0);

    const { results: schema } = await DB.prepare(
      `SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master
        WHERE tbl_name IN ('events', 'batches', 'batch_context') AND sql IS NOT NULL
        ORDER BY name`,
    ).all<{ type: string; name: string; tbl: string; sql: string }>();
    const indexes = schema.filter((s) => s.type === 'index').map((s) => s.name);
    expect(indexes).toEqual([
      'batches_by_received',
      'events_batch',
      'events_day',
      'events_identity',
      'events_install',
      'events_scope',
      'events_scope_name',
      // 0009's partial index, applied by `applyMigrationsFrom` after 0008.
      'events_user',
    ]);
    expect(schema.find((s) => s.name === 'events_identity')?.sql).toMatch(
      /UNIQUE INDEX[\s\S]*\(project_id, install_id, seq\)/,
    );
    for (const table of ['events', 'batches', 'batch_context']) {
      const sql = schema.find((s) => s.type === 'table' && s.name === table)?.sql ?? '';
      expect(sql, table).toMatch(/REFERENCES projects\(id\) ON DELETE CASCADE/);
      expect(sql, table).toMatch(/\)\s*STRICT$/);
    }

    // AUTOINCREMENT survived the rebuild: the next id continues past the old max.
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S2 }]);
    const maxId = await DB.prepare(`SELECT MAX(id) AS m FROM events`).first<{ m: number }>();
    expect(maxId?.m).toBeGreaterThan(Math.max(...before.results.map((r) => r.id)));
  });

  it('a job deployed before 0008 is applied still rolls and sweeps around orphaned rows', async () => {
    // Every migration but 0008: the Worker needs 0007's columns, not 0008's FK.
    await resetDatabase({ skip: [MIGRATION_0008] });
    const doomed = addDays(rawCutoffDay(NOW), -1);
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      // Orphans: a deleted project's rows, one recent and one past every window.
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: 'ghost' },
      { day: doomed, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: 'ghost' },
    ]);

    // The old job rolled each day across all projects, and the rollup tables'
    // FK (0002) rejected the ghost project's row — failing the whole day's batch,
    // so `rolled` came up short and the sweep was skipped, every night, forever.
    const result = await runScheduled(testEnv, NOW);
    for (let i = 1; i <= 4; i += 1) expect(result.rolled).toContain(addDays(TODAY, -i));
    expect(await rollupEvents(PROJECT, YESTERDAY)).toBe(1);
    expect(await rawCount(PROJECT, doomed)).toBe(0);
    expect(await rollupEvents(PROJECT, doomed)).toBe(1);
    // An orphan older than every live project's window goes; a recent one waits.
    expect(await rawCount('ghost', doomed)).toBe(0);
    expect(await rawCount('ghost', YESTERDAY)).toBe(1);
  });

  it('0005’s installs backfill does not fail on orphaned events', async () => {
    // 0005 backfills `installs` (FK to projects) from `events` (no FK before
    // 0008). `OR IGNORE` does not cover a foreign-key failure, so one orphaned
    // event made the migration abort — and a failed D1 migration blocks deploy.
    await resetDatabase({ migrations: 4 });
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: 'ghost' },
    ]);
    await applyMigrationsFrom(4);

    const rows = await DB.prepare(`SELECT project_id AS p FROM installs ORDER BY project_id`).all<{
      p: string;
    }>();
    expect(rows.results).toEqual([{ p: PROJECT }]);
  });
});

// -----------------------------------------------------------------------------
// 3. The read boundary after a retention change
// -----------------------------------------------------------------------------

describe('rawBoundaryDay after retention is raised', () => {
  async function rollAndSweepDay100(): Promise<string> {
    const day100 = addDays(TODAY, -100);
    await seedEvents([
      { day: day100, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: day100, name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
    ]);
    await runScheduled(testEnv, NOW); // 90 days: rolled, then swept
    expect(await rawCount(PROJECT, day100)).toBe(0);
    return day100;
  }

  it('reads a day that exists only in the rollups from the rollups (raw rows elsewhere)', async () => {
    const day100 = await rollAndSweepDay100();
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S2 }]);
    await setRetention(PROJECT, 180);

    const { rows } = await summary(DB, { projectId: PROJECT, from: day100, to: day100, now: NOW });
    expect(rows).toEqual([{ date: day100, opens: 2, sessions: 2, activeInstalls: 2, events: 2 }]);
  });

  it('…and with no raw rows at all', async () => {
    const day100 = await rollAndSweepDay100();
    await setRetention(PROJECT, 180);

    const { rows } = await summary(DB, { projectId: PROJECT, from: day100, to: day100, now: NOW });
    expect(rows[0]).toMatchObject({ events: 2 });
  });

  it('still reads a long-retention project’s surviving raw rows as raw', async () => {
    await setRetention(PROJECT, 180);
    const day150 = addDays(TODAY, -150);
    await seedEvents([{ day: day150, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(day150);
  });
});

// -----------------------------------------------------------------------------
// 4. The breakdown prop cap ranks by presence
// -----------------------------------------------------------------------------

describe('the §8.2 prop cap ranks props by how often they are PRESENT', () => {
  // `z_common` is on 40 events; `a00`…`a19` are on one event each. Ranked by
  // value rows PLUS the null row (which counts events LACKING the prop), every
  // prop totals 60 — so the tie fell to byte order and the 20 single-use props
  // pushed out the only prop that is actually common.
  const OLD = addDays(TODAY, -120);
  const singles = Array.from({ length: MAX_BREAKDOWN_PROPS }, (_, i) => `a${String(i).padStart(2, '0')}`);

  function rows(day: string, commonCount: number, singleProps: string[]) {
    return [
      ...Array.from({ length: commonCount }, () => ({
        day, name: 'wide', installId: INSTALLS.a, sessionId: S1, props: { z_common: 'yes' },
      })),
      ...singleProps.map((p) => ({
        day, name: 'wide', installId: INSTALLS.b, sessionId: S2, props: { [p]: 'once' },
      })),
    ];
  }

  async function rollAway(day: string): Promise<void> {
    await DB.batch(rollupStatements(testEnv, day, NOW.toISOString(), PROJECT));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(day).run();
  }

  async function props(from: string, to: string): Promise<Set<string>> {
    const { rows: out } = await propBreakdown(DB, { projectId: PROJECT, from, to, name: 'wide', now: NOW });
    return new Set(out.map((r) => r.prop));
  }

  it('on a raw range', async () => {
    await seedEvents(rows(YESTERDAY, 40, singles));
    const kept = await props(YESTERDAY, YESTERDAY);
    expect(kept.size).toBe(MAX_BREAKDOWN_PROPS);
    expect(kept.has('z_common')).toBe(true);
  });

  it('on a rollup range', async () => {
    await seedEvents(rows(OLD, 40, singles));
    await rollAway(OLD);
    const kept = await props(OLD, OLD);
    expect(kept.size).toBe(MAX_BREAKDOWN_PROPS);
    expect(kept.has('z_common')).toBe(true);
  });

  it('on a mixed range', async () => {
    // The rollup half is the tie; the raw half adds one more prop, so the merged
    // ranking (not either source's own) is what has to keep `z_common`.
    await seedEvents(rows(OLD, 40, singles));
    await rollAway(OLD);
    await seedEvents([
      { day: YESTERDAY, name: 'wide', installId: INSTALLS.a, sessionId: S1, props: { b_other: 'x' } },
    ]);
    const kept = await props(OLD, YESTERDAY);
    expect(kept.size).toBe(MAX_BREAKDOWN_PROPS);
    expect(kept.has('z_common')).toBe(true);
  });

  it('answers the null row the same whether a day is served raw or from its rollup', async () => {
    // `section` is reported on one day only. The rollup decides which props get a
    // null row PER DAY (the keys seen that day), so the day without `section`
    // stores no null row for it. The raw path decided per RANGE, and counted the
    // other day's events as "did not report" — so one range gave two answers
    // depending on which side of the retention boundary it sat.
    const d1 = addDays(TODAY, -3);
    const d2 = addDays(TODAY, -2);
    await seedEvents([
      { day: d1, name: 'opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'x' } },
      { day: d1, name: 'opened', installId: INSTALLS.a, sessionId: S1, props: {} },
      { day: d2, name: 'opened', installId: INSTALLS.b, sessionId: S2, props: {} },
      { day: d2, name: 'opened', installId: INSTALLS.b, sessionId: S2, props: {} },
    ]);
    const raw = await propBreakdown(DB, { projectId: PROJECT, from: d1, to: d2, name: 'opened', now: NOW });

    for (const day of [d1, d2]) await DB.batch(rollupStatements(testEnv, day, NOW.toISOString(), PROJECT));
    const { rows: rolled } = await DB.prepare(
      `SELECT prop, is_null AS n, SUM(count) AS count FROM daily_prop_rollups
        WHERE project_id = ?1 AND name = 'opened' AND include_debug = 0
        GROUP BY prop, value_key, is_null ORDER BY prop, is_null`,
    )
      .bind(PROJECT)
      .all<{ prop: string; n: number; count: number }>()
      .then((r) => ({ rows: r.results }));

    expect(raw.rows).toEqual([
      { prop: 'section', value: 'x', count: 1, installs: 1 },
      { prop: 'section', value: null, count: 1, installs: 1 },
    ]);
    expect(rolled).toEqual([
      { prop: 'section', n: 0, count: 1 },
      { prop: 'section', n: 1, count: 1 },
    ]);
  });
});

// -----------------------------------------------------------------------------
// 6. installs.first_seen_day under out-of-order delivery
// -----------------------------------------------------------------------------

describe('installs.first_seen_day is the earliest day seen, whatever order batches arrive in', () => {
  it('moves EARLIER when an older batch arrives second, never later', async () => {
    const threeAgo = addDays(TODAY, -3);
    // Today's batch first (the device came online), then the queued batch from
    // three days ago — the order §1's offline queue can deliver them in.
    await post(makeBatch({ batchId: batchId(7101), events: [makeEvent({ ts: `${TODAY}T10:00:00.000Z`, seq: 5 })] }));
    await post(makeBatch({ batchId: batchId(7102), events: [makeEvent({ ts: `${threeAgo}T10:00:00.000Z`, seq: 1 })] }));
    // And a later one must not move it forward again.
    await post(makeBatch({ batchId: batchId(7103), events: [makeEvent({ ts: `${TODAY}T11:00:00.000Z`, seq: 6 })] }));

    const rows = await DB.prepare(`SELECT first_seen_day AS day FROM installs WHERE project_id = ?1`)
      .bind(PROJECT)
      .all<{ day: string }>();
    expect(rows.results).toEqual([{ day: threeAgo }]);
  });
});

// -----------------------------------------------------------------------------
// 7. Rate-limit buckets are per endpoint
// -----------------------------------------------------------------------------

describe('pre-auth rate-limit buckets are namespaced per endpoint', () => {
  it('a write key hammered against the read endpoints does not drain its ingest bucket', async () => {
    // The write key ships in every app binary (§7), so anyone can present it as a
    // read key. Each such request is a 401 — but it used to count against the
    // SAME bucket ingest uses, so 600 of them a minute 429'd the app's own fleet.
    const t = NOW.getTime();
    for (let i = 0; i < PRE_AUTH_LIMIT_PER_WINDOW + 10; i += 1) {
      await checkPreAuthRate(WRITE_KEY, t, 'read').catch(() => undefined);
    }
    await expect(checkPreAuthRate(WRITE_KEY, t, 'ingest')).resolves.toBeUndefined();
    // The read bucket itself still limits at the read number.
    await expect(checkPreAuthRate(WRITE_KEY, t, 'read')).rejects.toThrow();
    expect(READ_LIMIT_PER_WINDOW).toBeLessThan(PRE_AUTH_LIMIT_PER_WINDOW);
  });
});

// -----------------------------------------------------------------------------
// raw_complete_from (0007): a retention increase does not make swept days raw
// -----------------------------------------------------------------------------

async function marker(projectId: string = PROJECT): Promise<string | null> {
  const row = await DB.prepare(`SELECT raw_complete_from AS m FROM projects WHERE id = ?1`)
    .bind(projectId)
    .first<{ m: string | null }>();
  return row?.m ?? null;
}

describe('raw_complete_from after a retention increase (0007)', () => {
  const D = addDays(TODAY, -120);
  const D95 = addDays(TODAY, -95);

  /** 90-day project: D and D95 rolled and swept; a recent raw row so it is live. */
  async function sweptUnderNinety(): Promise<void> {
    await seedEvents([
      { day: D, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: D, name: 'app_open', installId: INSTALLS.b, sessionId: S2 },
      { day: D95, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    ]);
    await runScheduled(testEnv, NOW);
    expect(await rawCount(PROJECT, D)).toBe(0);
    expect(await rollupEvents(PROJECT, D)).toBe(2);
    expect(await rollupEvents(PROJECT, D95)).toBe(1);
  }

  it('the probe: late batch and stray row for a swept day, read, then that day expires again', async () => {
    await sweptUnderNinety();
    await setProjectRetention(DB, PROJECT, 180, NOW);
    expect(await marker()).toBe(rawCutoffDay(NOW));

    // A legitimate late batch for D, through ingest: it lands on the marker,
    // not on D, so it cannot pose as D's whole history.
    expect(
      (await post(makeBatch({ batchId: batchId(7201), events: [makeEvent({ ts: `${D}T10:00:00.000Z`, seq: 900 })] })))
        .status,
    ).toBe(202);
    const landed = await DB.prepare(`SELECT day FROM events WHERE seq = 900`).first<{ day: string }>();
    expect(landed?.day).toBe(rawCutoffDay(NOW));

    // And a stray an older Worker wrote straight into D.
    await seedEvents([{ day: D, name: 'app_open', installId: INSTALLS.b, sessionId: S1 }]);

    // Reads: D and D95 come from their rollups, not from raw (a 1, and a 0).
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(rawCutoffDay(NOW));
    const at = async (day: string) =>
      (await summary(DB, { projectId: PROJECT, from: day, to: day, now: NOW })).rows[0];
    expect(await at(D)).toMatchObject({ events: 2, activeInstalls: 2 });
    expect(await at(D95)).toMatchObject({ events: 1 });

    // The night D expires under the 180-day window: the stray is deleted, and
    // D's rollup is NOT rebuilt from it.
    await runScheduled(testEnv, nightOf(60));
    expect(await rawCount(PROJECT, D)).toBe(0);
    expect(await rollupEvents(PROJECT, D)).toBe(2);
  });

  it('a wrong-clock ts after the increase clamps onto the marker, not the new cutoff', async () => {
    await sweptUnderNinety();
    await setProjectRetention(DB, PROJECT, 180, NOW);
    await post(
      makeBatch({ batchId: batchId(7202), events: [makeEvent({ ts: `${addDays(TODAY, -900)}T10:00:00.000Z`, seq: 901 })] }),
    );
    const row = await DB.prepare(`SELECT day FROM events WHERE seq = 901`).first<{ day: string }>();
    expect(row?.day).toBe(rawCutoffDay(NOW));
    expect(row?.day).not.toBe(rawCutoffDay(NOW, 180));
  });

  it('is set only on an increase, keeps a newer marker, and starts at an unswept raw day', async () => {
    // An unswept day older than the clock cutoff (the 00:00–02:10 window) is
    // complete, so the marker starts there rather than above it.
    const unswept = addDays(rawCutoffDay(NOW), -2);
    await seedEvents([{ day: unswept, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    await setProjectRetention(DB, PROJECT, 180, NOW);
    expect(await marker()).toBe(unswept);

    // A second increase soon after: the old 180-day cutoff is older than the
    // marker, and the days between are still incomplete — the marker stays.
    await setProjectRetention(DB, PROJECT, 400, NOW);
    expect(await marker()).toBe(unswept);

    // A decrease leaves it alone; and an increase on a project with no raw rows
    // uses the old clock cutoff.
    await setProjectRetention(DB, PROJECT, 120, NOW);
    expect(await marker()).toBe(unswept);
    await setProjectRetention(DB, OTHER_PROJECT, 120, NOW);
    expect(await marker(OTHER_PROJECT)).toBe(rawCutoffDay(NOW));

    await expect(setProjectRetention(DB, PROJECT, 30, NOW)).rejects.toThrow(RangeError);
  });

  it('is cleared by the sweep once the window’s own cutoff has passed it', async () => {
    await setProjectRetention(DB, PROJECT, 180, NOW);
    expect(await marker()).toBe(rawCutoffDay(NOW));
    await runScheduled(testEnv, nightOf(30));
    expect(await marker()).not.toBeNull();
    await runScheduled(testEnv, nightOf(91));
    expect(await marker()).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The per-invocation query budget
// -----------------------------------------------------------------------------

/** `testEnv` with every D1 call counted: each run/all/first/raw, and each batch. */
function countingEnv(): { env: Env; calls: () => number } {
  let n = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'bind') {
          return (...args: unknown[]) => wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (key === 'run' || key === 'all' || key === 'first' || key === 'raw') {
          return (...args: unknown[]) => {
            n += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    originals.set(proxy, st);
    return proxy;
  };
  const db = new Proxy(DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          n += 1;
          return target.batch(stmts.map((st) => originals.get(st) ?? st));
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { env: { DB: db } as Env, calls: () => n };
}

describe('the nightly pass stays inside a per-invocation query budget', () => {
  it('defaults below the Workers Free limit of 1,000 Cloudflare-service subrequests', () => {
    expect(DEFAULT_QUERY_BUDGET).toBeLessThan(1_000);
    // …and the per-project cap is a month, not a quarter of 900 days.
    expect(sweepDaysCap(DEFAULT_QUERY_BUDGET)).toBe(31);
    expect(sweepDaysCap(45)).toBe(11);
  });

  it('many projects, small budget: every project is rolled and swept across nights, none starved', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const expiring = addDays(rawCutoffDay(NOW), -10);
    for (const id of ids) {
      await DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, ?1, ?2)`)
        .bind(id, NOW.toISOString())
        .run();
      await seedEvents([{ day: expiring, name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: id }]);
    }
    const remaining = async () =>
      (await DB.prepare(`SELECT COUNT(DISTINCT project_id) AS n FROM events WHERE day = ?1`)
        .bind(expiring)
        .first<{ n: number }>())?.n ?? 0;

    const BUDGET = 16;
    let previous = await remaining();
    let nights = 0;
    while (previous > 0) {
      const counted = countingEnv();
      await runScheduled(counted.env, nightOf(nights), { queryBudget: BUDGET });
      expect(counted.calls(), `night ${nights}`).toBeLessThanOrEqual(BUDGET);
      const now = await remaining();
      expect(now, `night ${nights} made progress`).toBeLessThan(previous);
      previous = now;
      nights += 1;
      expect(nights).toBeLessThanOrEqual(ids.length);
    }
    expect(nights).toBeGreaterThan(1); // the budget really did split the work
    for (const id of ids) expect(await rollupEvents(id, expiring), id).toBe(1);
  });

  it('rotation: projects with fresh traffic every night cannot starve the ones after them', async () => {
    // Every project gets a new raw row each night, so every project has trailing
    // work every night. Ordered by id alone, the first few would take the whole
    // budget forever and the last ones would never be swept. Ordered by when each
    // was last COMPLETED, the budget walks the whole list.
    const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const expiring = addDays(rawCutoffDay(NOW), -10);
    for (const id of ids) {
      await DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, ?1, ?2)`)
        .bind(id, NOW.toISOString())
        .run();
      await seedEvents([{ day: expiring, name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: id }]);
    }
    const BUDGET = 9 + 2 * 7; // fixed overhead + two projects' worth (4 re-rolls, select, roll, delete)
    for (let night = 0; night < ids.length; night += 1) {
      const t = nightOf(night);
      for (const id of ids) {
        await seedEvents([{ day: addDays(today(t), -1), name: 'app_open', installId: INSTALLS.b, sessionId: S2, projectId: id }]);
      }
      await runScheduled(testEnv, t, { queryBudget: BUDGET });
    }
    for (const id of ids) expect(await rawCount(id, expiring), id).toBe(0);
  });

  it('a default-budget night with two projects stays within it', async () => {
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
      { day: addDays(rawCutoffDay(NOW), -1), name: 'app_open', installId: INSTALLS.a, sessionId: S2 },
    ]);
    const counted = countingEnv();
    const result = await runScheduled(counted.env, NOW);
    expect(counted.calls()).toBeLessThanOrEqual(DEFAULT_QUERY_BUDGET);
    expect(result.rolled).toHaveLength(5);
  });
});

/**
 * `testEnv` whose D1 runs `hook` once, just before the first statement (or batch
 * containing a statement) whose SQL matches `pattern` executes — to land a
 * concurrent write at an exact point inside a pass.
 */
function hookedEnv(pattern: RegExp, hook: () => Promise<void>, every = false): Env {
  let fired = false;
  const fire = async (sql: string) => {
    if ((every || !fired) && pattern.test(sql)) {
      fired = true;
      await hook();
    }
  };
  // Each proxy remembers its real statement and SQL, so a batch can unwrap it.
  const info = new WeakMap<object, { real: D1PreparedStatement; sql: string }>();
  const wrap = (real: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'bind') {
          return (...args: unknown[]) => wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args), sql);
        }
        if (key === 'run' || key === 'all' || key === 'first' || key === 'raw') {
          return async (...args: unknown[]) => {
            await fire(sql);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    info.set(proxy, { real, sql });
    return proxy;
  };
  const db = new Proxy(DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          for (const st of stmts) await fire(info.get(st)?.sql ?? '');
          return target.batch(stmts.map((st) => info.get(st)?.real ?? st));
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { DB: db } as Env;
}

describe('round 3: rotation under a capped sweep, races, idle projects', () => {
  it('a 400 → 90 backlog drains a slice a night while the neighbour’s yesterday is rolled every night', async () => {
    // The auditor's scenario. PROJECT has 300 expiring days; OTHER_PROJECT has
    // fresh traffic every night. Uncapped, PROJECT took the whole budget, never
    // finished, never rotated — and OTHER_PROJECT was not rolled for weeks.
    const backlog = Array.from({ length: 300 }, (_, k) => addDays(rawCutoffDay(NOW), -(k + 1)));
    await seedEvents(backlog.map((day) => ({ day, name: 'app_open', installId: INSTALLS.a, sessionId: S1 })));
    // An explicit small budget, so the neighbour and the backlog really do
    // compete for it (the default, 900, would serve both in one night).
    const BUDGET = 45;
    const cap = sweepDaysCap(BUDGET);

    let left = backlog.length;
    for (let night = 0; night < 5; night += 1) {
      const t = nightOf(night);
      const yesterday = addDays(today(t), -1);
      await seedEvents([
        { day: yesterday, name: 'app_open', installId: INSTALLS.b, sessionId: S2, projectId: OTHER_PROJECT },
      ]);
      await runScheduled(testEnv, t, { queryBudget: BUDGET });
      expect(await rollupEvents(OTHER_PROJECT, yesterday), `night ${night}`).toBe(1);
      const now = await DB.prepare(`SELECT COUNT(DISTINCT day) AS n FROM events WHERE project_id = ?1`)
        .bind(PROJECT)
        .first<{ n: number }>();
      // Each night removes at least the cap's worth (more as the cutoff advances).
      expect((now?.n ?? 0), `night ${night}`).toBeLessThanOrEqual(left - cap);
      left = now?.n ?? 0;
    }
    // And every day it did delete was rolled first.
    for (const day of backlog.slice(-cap)) expect(await rollupEvents(PROJECT, day), day).toBe(1);
  });

  it('a retention raise landing mid-pass stops the sweep deleting days the new window keeps', async () => {
    const doomed = addDays(rawCutoffDay(NOW), -1);
    await seedEvents([{ day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    const raced = hookedEnv(/DELETE FROM events\s+WHERE project_id = \?2 AND day = \?3/, async () => {
      await setProjectRetention(DB, PROJECT, 180, NOW);
    });
    await runScheduled(raced, NOW);
    expect(await rawCount(PROJECT, doomed)).toBe(1);
    expect(await marker()).not.toBeNull();
  });

  it('a retention raise landing mid-pass keeps the marker the pass would have cleared', async () => {
    // A stale marker the 90-day cutoff has long passed: moot, due to be cleared.
    await DB.prepare(`UPDATE projects SET raw_complete_from = ?2 WHERE id = ?1`)
      .bind(PROJECT, addDays(TODAY, -200))
      .run();
    const raced = hookedEnv(/SET raw_complete_from = NULL/, async () => {
      await setProjectRetention(DB, PROJECT, 400, NOW); // marker moves to today-89
    });
    await runScheduled(raced, NOW);
    expect(await marker()).toBe(rawCutoffDay(NOW));
    // Without the race, the moot marker is cleared as before.
    await DB.prepare(`UPDATE projects SET raw_complete_from = ?2 WHERE id = ?1`)
      .bind(OTHER_PROJECT, addDays(TODAY, -200))
      .run();
    await runScheduled(testEnv, NOW);
    expect(await marker(OTHER_PROJECT)).toBeNull();
  });

  it('idle projects cost no queries and are not written', async () => {
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    const baseline = countingEnv();
    await runScheduled(baseline.env, NOW);

    await resetDatabase();
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    for (let i = 0; i < 10; i += 1) {
      await DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, ?1, ?2)`)
        .bind(`idle${i}`, NOW.toISOString())
        .run();
    }
    const withIdle = countingEnv();
    await runScheduled(withIdle.env, NOW);

    expect(withIdle.calls()).toBe(baseline.calls());
    const touched = await DB.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE id LIKE 'idle%' AND rolled_at IS NOT NULL`,
    ).first<{ n: number }>();
    expect(touched?.n).toBe(0);
    const active = await DB.prepare(`SELECT rolled_at AS r FROM projects WHERE id = ?1`)
      .bind(PROJECT)
      .first<{ r: string | null }>();
    expect(active?.r).toBe(NOW.toISOString());
  });
});

describe('final audit: rotation without the tail, minimum budget, wall-time stop', () => {
  const rolledAtOf = async (id: string) =>
    (await DB.prepare(`SELECT rolled_at AS r FROM projects WHERE id = ?1`).bind(id).first<{ r: string | null }>())?.r ??
    null;

  it('a pass whose tail never runs has still rotated every project it worked on', async () => {
    // Stand-in for a pass killed after its project work (Workers Free gives a cron
    // 10 ms of CPU): every tail statement fails. Rotation used to live in the
    // tail, so the same projects stayed first — and got cut off — every night.
    await seedEvents([
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: addDays(rawCutoffDay(NOW), -1), name: 'app_open', installId: INSTALLS.b, sessionId: S1, projectId: OTHER_PROJECT },
    ]);
    const killed = hookedEnv(
      /INSERT INTO rollup_state|WHERE id IN|raw_complete_from = NULL|FROM batch_context|received_at <|NOT IN \(SELECT id FROM projects\)/,
      async () => {
        throw new Error('pass killed');
      },
      true,
    );
    await runScheduled(killed, NOW);
    expect(await rolledAtOf(PROJECT)).toBe(NOW.toISOString()); // trailing batch
    expect(await rolledAtOf(OTHER_PROJECT)).toBe(NOW.toISOString()); // expiring-day batch
  });

  it('clamps a hand-set tiny budget up to MIN_QUERY_BUDGET, which still fits a project', async () => {
    // The minimum is derived, not guessed: fixed cost + one project's worst night.
    expect(2 + TAIL_QUERIES + 3 + sweepDaysCap(MIN_QUERY_BUDGET)).toBeLessThanOrEqual(MIN_QUERY_BUDGET);
    const ids = ['m0', 'm1', 'm2'];
    const expiring = addDays(rawCutoffDay(NOW), -10);
    for (const id of ids) {
      await DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, ?1, ?2)`).bind(id, NOW.toISOString()).run();
      await seedEvents([{ day: expiring, name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: id }]);
    }
    const counted = countingEnv();
    await runScheduled(counted.env, NOW, { queryBudget: 1 });
    expect(counted.calls()).toBeLessThanOrEqual(MIN_QUERY_BUDGET);
    // At budget 1 nothing could run; clamped, the night does real work and rotates it.
    const swept = await DB.prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE id IN ('m0','m1','m2') AND rolled_at IS NOT NULL`,
    ).first<{ n: number }>();
    expect(swept?.n ?? 0).toBeGreaterThan(0);
  });

  it('stops starting project work once the wall-time allowance is spent', async () => {
    const doomed = addDays(rawCutoffDay(NOW), -1);
    await seedEvents([
      { day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S2 },
    ]);
    // A clock that jumps 11 minutes the first time the budget looks at it after
    // construction: every take() sees the deadline passed.
    let t = 1_000_000;
    let reads = 0;
    const clock = () => {
      reads += 1;
      return reads === 1 ? t : (t += 11 * 60 * 1_000);
    };
    const result = await runScheduled(testEnv, NOW, { clock });
    expect(result.deletedEvents).toBe(0);
    expect(await rawCount(PROJECT, doomed)).toBe(1);
    expect(await rollupEvents(PROJECT, YESTERDAY)).toBeNull();
    // The same night with time to spare does the work.
    await runScheduled(testEnv, NOW);
    expect(await rawCount(PROJECT, doomed)).toBe(0);
    expect(await rollupEvents(PROJECT, YESTERDAY)).toBe(1);
  });
});
