// The scheduled job: rollup correctness, idempotency, retention boundary, and
// reads past raw retention. Schema §13 and backends/cloudflare/README.md.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { runScheduled, REROLL_DAYS } from '../src/rollup.js';
import { addDays, rawCutoffDay, RAW_RETENTION_DAYS } from '../src/dates.js';
import { DB, INSTALLS, PROJECT, READ_KEY, readRequest, resetDatabase, seedEvents } from './helpers.js';
import type { Env } from '../src/env.js';

// A fixed clock. Every boundary below is derived from it with the same helpers
// the Worker uses, so a test cannot pass by hard-coding a date the production
// code computes differently — the off-by-one is what these tests are for.
const NOW = new Date('2026-08-17T02:10:00.000Z');
const TODAY = '2026-08-17';
const YESTERDAY = addDays(TODAY, -1);

const S1 = '1786012978-40371852';
const S2 = '1786013999-11112222';

const testEnv = env as never as Env;

async function get(params: Record<string, string>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(readRequest('/v1/summary', params, READ_KEY), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  await resetDatabase();
});

/**
 * Yesterday's fixture, mirroring read.test.ts's summary fixture so the rollup
 * and the raw query are asserted to produce the SAME numbers — that equivalence
 * is the whole promise of the rollups.
 *
 * Excluding debug: opens 3 · sessions 3 · activeInstalls 2 · events 4
 * Including debug: opens 4 · sessions 3 · activeInstalls 2 · events 5
 */
async function seedYesterday(): Promise<void> {
  await seedEvents([
    { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    { day: YESTERDAY, name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'analytics' } },
    { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S2 },
    { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
    { day: YESTERDAY, name: 'app_open', installId: INSTALLS.b, sessionId: S1, isDebug: true },
  ]);
}

describe('rollup', () => {
  it('rolls yesterday into both includeDebug variants with the §8.1 definitions', async () => {
    await seedYesterday();
    await runScheduled(testEnv, NOW);

    const excluded = await DB.prepare(
      `SELECT opens, sessions, active_installs AS ai, events FROM daily_rollups
        WHERE project_id = ?1 AND day = ?2 AND include_debug = 0`,
    )
      .bind(PROJECT, YESTERDAY)
      .first<{ opens: number; sessions: number; ai: number; events: number }>();

    const included = await DB.prepare(
      `SELECT opens, sessions, active_installs AS ai, events FROM daily_rollups
        WHERE project_id = ?1 AND day = ?2 AND include_debug = 1`,
    )
      .bind(PROJECT, YESTERDAY)
      .first<{ opens: number; sessions: number; ai: number; events: number }>();

    expect(excluded).toEqual({ opens: 3, sessions: 3, ai: 2, events: 4 });
    expect(included).toEqual({ opens: 4, sessions: 3, ai: 2, events: 5 });
  });

  it('rolls up event-name and prop breakdowns', async () => {
    await seedYesterday();
    await runScheduled(testEnv, NOW);

    const names = await DB.prepare(
      `SELECT name, count, installs FROM daily_event_rollups
        WHERE day = ?1 AND include_debug = 0 ORDER BY name`,
    )
      .bind(YESTERDAY)
      .all<{ name: string; count: number; installs: number }>();

    expect(names.results).toEqual([
      { name: 'app_open', count: 3, installs: 2 },
      { name: 'project_opened', count: 1, installs: 1 },
    ]);

    const props = await DB.prepare(
      `SELECT prop, value, is_null, count, installs FROM daily_prop_rollups
        WHERE day = ?1 AND include_debug = 0 AND name = 'project_opened'
        ORDER BY is_null, value`,
    )
      .bind(YESTERDAY)
      .all<{ prop: string; value: string | null; is_null: number; count: number; installs: number }>();

    // One `project_opened` event, carrying section=analytics. No null row,
    // because every project_opened event that day had the prop.
    expect(props.results).toEqual([
      { prop: 'section', value: 'analytics', is_null: 0, count: 1, installs: 1 },
    ]);
  });

  it('is idempotent: running twice does not double any count', async () => {
    await seedYesterday();
    await runScheduled(testEnv, NOW);
    await runScheduled(testEnv, NOW);

    const rows = await DB.prepare(
      `SELECT COUNT(*) AS n, SUM(events) AS total FROM daily_rollups
        WHERE day = ?1 AND include_debug = 0`,
    )
      .bind(YESTERDAY)
      .first<{ n: number; total: number }>();

    // Exactly one row, and its `events` is still 4 — an `INSERT` without the
    // paired `DELETE`, or an upsert that added instead of replacing, fails here.
    expect(rows?.n).toBe(1);
    expect(rows?.total).toBe(4);
  });

  it('self-corrects after events are deleted (the §13 erasure path)', async () => {
    await seedYesterday();
    await runScheduled(testEnv, NOW);

    // Erase install B: 2 of yesterday's 5 events, 1 of the 4 non-debug ones.
    await DB.prepare(`DELETE FROM events WHERE install_id = ?1`).bind(INSTALLS.b).run();
    await runScheduled(testEnv, NOW);

    const row = await DB.prepare(
      `SELECT active_installs AS ai, events FROM daily_rollups
        WHERE day = ?1 AND include_debug = 0`,
    )
      .bind(YESTERDAY)
      .first<{ ai: number; events: number }>();

    // A bare `ON CONFLICT DO UPDATE` would leave activeInstalls at 2 here. The
    // delete-then-insert brings it down to 1, which is what "self-correcting"
    // means and why the job is written that way.
    expect(row).toEqual({ ai: 1, events: 3 });
  });

  it('re-rolls a trailing window so a late offline batch is picked up', async () => {
    // §1: a queued offline batch can be days old. This lands in a day that a
    // previous pass already rolled.
    const threeDaysAgo = addDays(TODAY, -3);
    expect(REROLL_DAYS).toBeGreaterThanOrEqual(3);

    await runScheduled(testEnv, NOW); // rolls an empty window
    await seedEvents([{ day: threeDaysAgo, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    await runScheduled(testEnv, NOW);

    const row = await DB.prepare(
      `SELECT events FROM daily_rollups WHERE day = ?1 AND include_debug = 0`,
    )
      .bind(threeDaysAgo)
      .first<{ events: number }>();
    expect(row?.events).toBe(1);
  });

  it('records what it rolled', async () => {
    await seedYesterday();
    const result = await runScheduled(testEnv, NOW);
    expect(result.rolled).toHaveLength(REROLL_DAYS);
    expect(result.rolled[0]).toBe(YESTERDAY);

    const state = await DB.prepare(`SELECT event_rows FROM rollup_state WHERE day = ?1`)
      .bind(YESTERDAY)
      .first<{ event_rows: number }>();
    expect(state?.event_rows).toBe(5);
  });
});

describe('retention (§13 — raw events MUST NOT outlive 90 days)', () => {
  it('deletes raw events older than the cutoff and keeps the cutoff day itself', async () => {
    const cutoff = rawCutoffDay(NOW);
    const tooOld = addDays(cutoff, -1);

    await seedEvents([
      { day: tooOld, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: cutoff, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    ]);

    const result = await runScheduled(testEnv, NOW);
    expect(result.deletedEvents).toBe(1);

    const days = await DB.prepare(`SELECT day FROM events ORDER BY day`).all<{ day: string }>();
    // Both boundaries asserted: one day too aggressive loses `cutoff`, one day
    // too lax keeps `tooOld` past the 90-day promise.
    expect(days.results.map((r) => r.day)).toEqual([cutoff, YESTERDAY]);
  });

  it('keeps exactly 90 days of raw events inclusive of today', async () => {
    const cutoff = rawCutoffDay(NOW);
    // The window [cutoff, today] must be RAW_RETENTION_DAYS days wide. If this
    // drifts, the README's "90 days" claim is a lie.
    const span = (Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${cutoff}T00:00:00Z`)) / 86_400_000 + 1;
    expect(span).toBe(RAW_RETENTION_DAYS);
  });

  it('does not delete raw events when the rollup failed', async () => {
    // The one unrecoverable ordering bug: deleting raw rows for a day that was
    // never aggregated. Simulated by removing a rollup table so every roll
    // throws.
    const cutoff = rawCutoffDay(NOW);
    await seedEvents([{ day: addDays(cutoff, -1), name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    await DB.prepare(`DROP TABLE daily_prop_rollups`).run();

    const result = await runScheduled(testEnv, NOW);
    expect(result.rolled).toHaveLength(0);
    expect(result.deletedEvents).toBe(0);

    const remaining = await DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  it('rolls up an expiring day that the trailing window never reached', async () => {
    // The regression this guards: the nightly job re-rolls only the last few
    // days, so a day that reached the cutoff unrolled — because the cron was
    // down for a week, or a batch arrived a week late — would have its raw rows
    // deleted having never been aggregated, and its history would be gone for
    // good. The sweep must roll every day it is about to delete.
    const cutoff = rawCutoffDay(NOW);
    const doomed = addDays(cutoff, -1);

    await seedEvents([
      { day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: doomed, name: 'project_opened', installId: INSTALLS.b, sessionId: S2 },
    ]);

    // Nothing has rolled this day: it is far outside the REROLL_DAYS window.
    const before = await DB.prepare(
      `SELECT COUNT(*) AS n FROM daily_rollups WHERE day = ?1`,
    )
      .bind(doomed)
      .first<{ n: number }>();
    expect(before?.n).toBe(0);

    await runScheduled(testEnv, NOW);

    // Raw rows are gone …
    const raw = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE day = ?1`)
      .bind(doomed)
      .first<{ n: number }>();
    expect(raw?.n).toBe(0);

    // … and the history survived, because the day was rolled on the way out.
    const row = await DB.prepare(
      `SELECT opens, sessions, active_installs AS ai, events FROM daily_rollups
        WHERE day = ?1 AND include_debug = 0`,
    )
      .bind(doomed)
      .first<{ opens: number; sessions: number; ai: number; events: number }>();
    expect(row).toEqual({ opens: 1, sessions: 2, ai: 2, events: 2 });
  });

  it('serves that rescued day through /v1/summary', async () => {
    // End-to-end version of the above: the number a reader actually sees.
    const cutoff = rawCutoffDay(NOW);
    const doomed = addDays(cutoff, -1);
    await seedEvents([{ day: doomed, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);

    await runScheduled(testEnv, NOW);

    const body = (await (await get({ projectId: PROJECT, from: doomed, to: doomed })).json()) as {
      rows: Array<{ date: string; events: number }>;
    };
    expect(body.rows).toEqual([expect.objectContaining({ date: doomed, events: 1 })]);
  });

  it('purges context rows only once their events are gone', async () => {
    const cutoff = rawCutoffDay(NOW);
    await seedEvents([
      { day: addDays(cutoff, -1), name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    ]);
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);

    const before = await DB.prepare(`SELECT COUNT(*) AS n FROM batch_context`).first<{ n: number }>();
    expect(before?.n).toBe(0); // seedEvents writes no context rows

    // Insert a context row for a batch whose events are about to age out, and
    // one for a batch whose events survive.
    const rows = await DB.prepare(`SELECT DISTINCT batch_id, day FROM events`).all<{
      batch_id: string;
      day: string;
    }>();
    for (const r of rows.results) {
      await DB.prepare(
        `INSERT INTO batch_context (
           batch_id, project_id, sent_at, sdk_version, app_version, app_build, bundle_id,
           os_name, os_version, device_model, arch, locale, region,
           screen_width, screen_height, screen_scale, is_debug, is_testflight, color_scheme
         ) VALUES (?1,?2,'2099-01-01T00:00:00.000Z','0.1.0','1.0','1','com.x','macOS','15',
                   'Mac15,3','arm64','en_US','US',0,0,1.0,0,0,NULL)`,
      )
        .bind(r.batch_id, PROJECT)
        .run();
    }

    await runScheduled(testEnv, NOW);

    // The surviving batch keeps its context; the aged-out one loses it — and the
    // far-future `sent_at` must not have stranded it, which is the regression.
    const after = await DB.prepare(`SELECT COUNT(*) AS n FROM batch_context`).first<{ n: number }>();
    expect(after?.n).toBe(1);
  });

  it('keeps the dedupe ledger well past the §6 24-hour minimum', async () => {
    await seedYesterday();
    await runScheduled(testEnv, NOW);
    const row = await DB.prepare(`SELECT COUNT(*) AS n FROM batches`).first<{ n: number }>();
    expect(row?.n).toBeGreaterThan(0);
  });
});

describe('reads past raw retention are answered from rollups', () => {
  it('serves an old day from daily_rollups after its raw events are gone', async () => {
    const cutoff = rawCutoffDay(NOW);
    const oldDay = addDays(cutoff, -1);

    await seedEvents([
      { day: oldDay, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: oldDay, name: 'project_opened', installId: INSTALLS.a, sessionId: S1 },
      { day: oldDay, name: 'app_open', installId: INSTALLS.b, sessionId: S2 },
    ]);

    // Roll `oldDay` explicitly (the nightly window only reaches back a few
    // days), then let the sweep remove its raw rows.
    const { rollupStatements } = await import('../src/rollup.js');
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await runScheduled(testEnv, NOW);

    const raw = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE day = ?1`)
      .bind(oldDay)
      .first<{ n: number }>();
    expect(raw?.n).toBe(0); // raw is gone …

    const body = (await (await get({ projectId: PROJECT, from: oldDay, to: oldDay })).json()) as {
      rows: Array<{ date: string; opens: number; sessions: number; activeInstalls: number; events: number }>;
    };
    // … but the history survives, which is the point of keeping rollups
    // indefinitely.
    expect(body.rows).toEqual([
      { date: oldDay, opens: 2, sessions: 2, activeInstalls: 2, events: 3 },
    ]);
  });

  it('stitches a range that straddles the retention boundary without duplicating a day', async () => {
    const cutoff = rawCutoffDay(NOW);
    const oldDay = addDays(cutoff, -1);

    await seedEvents([
      { day: oldDay, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: cutoff, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    ]);

    const { rollupStatements } = await import('../src/rollup.js');
    // Roll BOTH days, so `cutoff` exists in raw AND in rollups. A read that
    // summed the two sources instead of choosing one per day would report 2.
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.batch(rollupStatements(testEnv, cutoff, NOW.toISOString()));
    await runScheduled(testEnv, NOW);

    const body = (await (await get({ projectId: PROJECT, from: oldDay, to: cutoff })).json()) as {
      rows: Array<{ date: string; events: number }>;
    };
    expect(body.rows).toEqual([
      { date: oldDay, events: 1 },
      { date: cutoff, events: 1 },
    ].map((r) => expect.objectContaining(r)));
  });
});
