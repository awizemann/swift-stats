// The scheduled job: rollup correctness, idempotency, retention boundary, and
// reads past raw retention. Schema §13 and backends/cloudflare/README.md.

import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { runScheduled, REROLL_DAYS, DEDUPE_RETENTION_DAYS, LEASE_TTL_MS } from '../src/rollup.js';
import { addDays, rawCutoffDay, today, RAW_RETENTION_DAYS } from '../src/dates.js';
import { MAX_BREAKDOWN_PROPS } from '../src/read.js';
import {
  DB,
  INSTALLS,
  PROJECT,
  READ_KEY,
  batchId,
  ingestRequest,
  makeBatch,
  makeEvent,
  readRequest,
  resetDatabase,
  seedEvents,
} from './helpers.js';
import type { Env } from '../src/env.js';

// The scheduled job's clock is injected, so it is fixed *within a run*; every
// boundary below is derived from it with the same helpers the Worker uses, so a
// test cannot pass by hard-coding a date the production code computes
// differently — the off-by-one is what these tests are for.
//
// The day itself is TODAY rather than a literal, because the read assertions
// below go through `worker.fetch`, which reads the real `new Date()`. A literal
// `2026-08-17` agreed with the real clock on the day it was written and would
// have drifted across the 90-day retention boundary about three months later, at
// which point these tests would fail for a reason unrelated to the code. 02:10 is
// the real cron time from wrangler.toml.
const TODAY = today(new Date());
const NOW = new Date(`${TODAY}T02:10:00.000Z`);
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

  /// The old version asserted `COUNT(*) > 0` after a sweep that had nothing to
  /// purge — true for any purge window at all, including a purge that ran with a
  /// one-second retention, and true even with the purge deleted entirely. It
  /// asserted that the sweep did not destroy the table.
  ///
  /// What §6 actually requires is that a `batchId` stays deduplicable for AT LEAST
  /// 24 hours, so the boundary is the thing to pin: a row from just inside the
  /// window survives, a row from well outside it goes, and the surviving row still
  /// makes a re-delivery a 202 rather than a second write.
  it('purges the dedupe ledger no sooner than the §6 24-hour minimum', async () => {
    const nowMs = NOW.getTime();
    const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString();

    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;

    const rows: Array<[string, string, string]> = [
      // [batch_id, received_at, why]
      ['A0000000-0000-4000-8000-000000000001', iso(HOUR), 'an hour ago'],
      ['A0000000-0000-4000-8000-000000000002', iso(DAY - HOUR), 'just inside 24h'],
      ['A0000000-0000-4000-8000-000000000003', iso(DAY + HOUR), 'just past 24h'],
      ['A0000000-0000-4000-8000-000000000004', iso(29 * DAY), 'inside the 30-day window'],
      ['A0000000-0000-4000-8000-000000000005', iso(31 * DAY), 'past the 30-day window'],
    ];
    for (const [id, receivedAt] of rows) {
      await DB.prepare(
        `INSERT INTO batches (batch_id, project_id, received_at, event_count) VALUES (?1, ?2, ?3, 1)`,
      )
        .bind(id, PROJECT, receivedAt)
        .run();
    }

    await seedYesterday();
    await runScheduled(testEnv, NOW);

    const survivors = await DB.prepare(
      `SELECT batch_id FROM batches WHERE batch_id LIKE 'A0000000%' ORDER BY batch_id`,
    ).all<{ batch_id: string }>();
    const surviving = new Set(survivors.results.map((r) => r.batch_id));

    // The §6 MUST: everything inside 24 hours is still deduplicable.
    expect(surviving.has(rows[0]![0])).toBe(true);
    expect(surviving.has(rows[1]![0])).toBe(true);
    // Everything the backend documents as its own, wider window.
    expect(surviving.has(rows[2]![0])).toBe(true);
    expect(surviving.has(rows[3]![0])).toBe(true);
    // And the purge actually purges — without this the test passes for a
    // no-op sweep, which is exactly what the old `COUNT(*) > 0` did.
    expect(surviving.has(rows[4]![0])).toBe(false);

    expect(DEDUPE_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  /// End-to-end on the same promise: a duplicate delivery of a batch received
  /// just under 24 hours ago must still answer 202 after a sweep, and must not
  /// write its events a second time.
  it('a batch inside the window is still deduplicated after a sweep', async () => {
    const body = makeBatch({ batchId: batchId(), events: [makeEvent()] });

    const first = createExecutionContext();
    const r1 = await worker.fetch(ingestRequest(body), env as never, first);
    await waitOnExecutionContext(first);
    expect(r1.status).toBe(202);

    // Backdate it to just inside the 24-hour minimum, then sweep.
    await DB.prepare(`UPDATE batches SET received_at = ?1 WHERE batch_id = ?2`)
      .bind(new Date(NOW.getTime() - 23 * 3_600_000).toISOString(), String(body.batchId).toUpperCase())
      .run();
    await runScheduled(testEnv, NOW);

    const second = createExecutionContext();
    const r2 = await worker.fetch(ingestRequest(body), env as never, second);
    await waitOnExecutionContext(second);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toMatchObject({ duplicate: true });

    const events = await DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE batch_id = ?1`,
    )
      .bind(String(body.batchId).toUpperCase())
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
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

describe('the rollup lease (§13: the sweep is the one irreversible operation)', () => {
  it('a second invocation bails while the first holds the lease', async () => {
    await seedYesterday();

    // Two passes started together. Without a lease both run: their
    // DELETE-then-INSERT rollups can interleave at the day granularity, leaving a
    // day whose rollup rows one pass deleted after the other inserted them — and
    // then BOTH reach step 3 and delete that day's raw rows.
    const [a, b] = await Promise.all([
      runScheduled(testEnv, NOW),
      runScheduled(testEnv, NOW),
    ]);

    const skipped = [a, b].filter((r) => r.skipped);
    const ran = [a, b].filter((r) => !r.skipped);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({ rolled: [], deletedEvents: 0, skipped: true });

    // The pass that ran still did its whole job.
    expect(ran[0]!.rolled).toContain(YESTERDAY);
    const row = await DB.prepare(
      `SELECT events FROM daily_rollups WHERE day = ?1 AND include_debug = 0`,
    )
      .bind(YESTERDAY)
      .first<{ events: number }>();
    expect(row?.events).toBe(4);
  });

  it('releases the lease on the way out, so the next pass runs', async () => {
    await seedYesterday();
    const first = await runScheduled(testEnv, NOW);
    expect(first.skipped).toBe(false);

    // No row left behind: a lease that outlived its run would lock the job out
    // for LEASE_TTL_MS, which for a daily cron is a skipped day.
    const held = await DB.prepare(`SELECT COUNT(*) AS n FROM rollup_lease`).first<{ n: number }>();
    expect(held?.n).toBe(0);

    const second = await runScheduled(testEnv, NOW);
    expect(second.skipped).toBe(false);
  });

  it('releases the lease even when the pass throws', async () => {
    // A crash mid-pass must not lock the job out. `daily_prop_rollups` is gone,
    // so every roll fails and the sweep bails — the `finally` still releases.
    await seedEvents([{ day: YESTERDAY, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    await DB.prepare(`DROP TABLE daily_prop_rollups`).run();

    const result = await runScheduled(testEnv, NOW);
    expect(result.skipped).toBe(false);
    expect(result.rolled).toHaveLength(0);

    const held = await DB.prepare(`SELECT COUNT(*) AS n FROM rollup_lease`).first<{ n: number }>();
    expect(held?.n).toBe(0);
  });

  it('takes over a lease abandoned longer ago than the TTL', async () => {
    // The isolate holding it was evicted mid-run and never released. After the
    // TTL the job must be able to proceed rather than being locked out forever.
    await DB.prepare(
      `INSERT INTO rollup_lease (id, holder, acquired_at) VALUES (1, 'crashed-pass', ?1)`,
    )
      .bind(new Date(NOW.getTime() - LEASE_TTL_MS - 60_000).toISOString())
      .run();

    await seedYesterday();
    const result = await runScheduled(testEnv, NOW);
    expect(result.skipped).toBe(false);
    expect(result.rolled).toContain(YESTERDAY);
  });

  it('does not take over a lease held inside the TTL', async () => {
    await DB.prepare(
      `INSERT INTO rollup_lease (id, holder, acquired_at) VALUES (1, 'live-pass', ?1)`,
    )
      .bind(new Date(NOW.getTime() - 60_000).toISOString())
      .run();

    await seedYesterday();
    const result = await runScheduled(testEnv, NOW);
    expect(result.skipped).toBe(true);
    expect(result.deletedEvents).toBe(0);

    // Nothing was rolled, and — the part that matters — nothing was deleted.
    const raw = await DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>();
    expect(raw?.n).toBe(5);
  });
});

describe('the 00:00–02:10 read window (a day must not read as zero while its raw rows exist)', () => {
  /**
   * The bug: the read path routed `day < rawCutoffDay(now)` to the rollups, and
   * `rawCutoffDay` is `today - 89` — but the sweep that actually deletes those
   * rows runs on a cron at 02:10 UTC. Between midnight and 02:10 every day, day
   * `today - 90` still has all its raw rows and was nevertheless answered from a
   * rollup. If that rollup was never written — the cron was down while the day was
   * inside REROLL_DAYS, the roll failed for it, a §1 offline batch landed in it
   * after it left the window — the day came back as a confident zero-filled ZERO,
   * which §8.1's zero-fill makes indistinguishable from "no data".
   */
  it('serves a day from raw rows when raw exists but no rollup does', async () => {
    const day = addDays(TODAY, -RAW_RETENTION_DAYS); // today - 90: below the clock cutoff
    expect(day < rawCutoffDay(NOW)).toBe(true);

    await seedEvents([
      { day, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day, name: 'project_opened', installId: INSTALLS.a, sessionId: S1 },
      { day, name: 'app_open', installId: INSTALLS.b, sessionId: S2 },
    ]);

    // Deliberately NOT rolled: this is the pre-02:10 state after a pass that
    // never covered this day.
    const rolled = await DB.prepare(
      `SELECT COUNT(*) AS n FROM daily_rollups WHERE day = ?1`,
    )
      .bind(day)
      .first<{ n: number }>();
    expect(rolled?.n).toBe(0);

    const body = (await (await get({ projectId: PROJECT, from: day, to: day })).json()) as {
      rows: Array<{ date: string; opens: number; sessions: number; activeInstalls: number; events: number }>;
    };
    // The old boundary answered { opens: 0, sessions: 0, activeInstalls: 0,
    // events: 0 } here, while all three rows sat in `events`.
    expect(body.rows).toEqual([
      { date: day, opens: 2, sessions: 2, activeInstalls: 2, events: 3 },
    ]);
  });

  it('still answers older days from the rollups, and never doubles a day', async () => {
    // Two days below the clock cutoff: one with raw rows, one with only a rollup.
    // The boundary must land between them, so neither day is lost and neither is
    // counted twice.
    const rawDay = addDays(TODAY, -RAW_RETENTION_DAYS);
    const rolledOnlyDay = addDays(rawDay, -1);

    await seedEvents([
      { day: rolledOnlyDay, name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
    ]);
    const { rollupStatements } = await import('../src/rollup.js');
    await DB.batch(rollupStatements(testEnv, rolledOnlyDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(rolledOnlyDay).run();

    await seedEvents([{ day: rawDay, name: 'app_open', installId: INSTALLS.b, sessionId: S2 }]);
    // `rawDay` also has a (stale, empty) rollup, so a read that summed both
    // sources instead of choosing one per day would be visible.
    await DB.batch(rollupStatements(testEnv, rawDay, NOW.toISOString()));

    const body = (await (
      await get({ projectId: PROJECT, from: rolledOnlyDay, to: rawDay })
    ).json()) as { rows: Array<{ date: string; events: number }> };

    expect(body.rows).toEqual([
      { date: rolledOnlyDay, events: 1 },
      { date: rawDay, events: 1 },
    ].map((r) => expect.objectContaining(r)));
  });

  it('a project with only recent data still reads its older days from rollups', async () => {
    // The boundary is derived from observed raw rows, so it must never move UP
    // past the clock's cutoff: a project whose oldest raw row is yesterday must
    // still have its pre-retention days served from rollups, not reported as zero.
    const oldDay = addDays(TODAY, -RAW_RETENTION_DAYS - 5);
    await seedEvents([{ day: oldDay, name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    const { rollupStatements } = await import('../src/rollup.js');
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(oldDay).run();

    // The project's only raw rows are from yesterday.
    await seedYesterday();

    const body = (await (await get({ projectId: PROJECT, from: oldDay, to: oldDay })).json()) as {
      rows: Array<{ date: string; events: number }>;
    };
    expect(body.rows).toEqual([expect.objectContaining({ date: oldDay, events: 1 })]);
  });
});

describe('the §8.2 breakdown prop cap applies to every source', () => {
  /**
   * `MAX_BREAKDOWN_PROPS` was a `LIMIT` in the RAW branch's SQL only. The rollup
   * branch had no cap at all, so:
   *
   *   * a range served entirely from rollups returned an unbounded number of
   *     props, silently exceeding the number the README documents, and
   *   * a MIXED range returned "raw's top 20, plus every prop the rollups knew
   *     about" — a prop set that depended on which side of the 90-day boundary the
   *     requested range happened to straddle.
   *
   * The cap is now applied once, over the merged totals, so the answer is the same
   * shape whatever the range's sources are.
   */
  const PROP_COUNT = 30; // comfortably over the cap of 20

  async function top(from: string, to: string) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      readRequest('/v1/events/top', { projectId: PROJECT, from, to, name: 'wide_event' }, READ_KEY),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Asserted, not assumed: a breakdown served from rollups used to answer 500
    // (see the `"isNull"` note in read.ts), and a bare `.rows` read would have
    // failed with an unhelpful "cannot read properties of undefined".
    expect(response.status).toBe(200);
    return (await response.json()) as { rows: Array<{ prop: string; value: unknown; count: number }> };
  }

  /** One event carrying `PROP_COUNT` distinct props, each with a distinct value. */
  function wideProps(seed: number): Record<string, string> {
    const props: Record<string, string> = {};
    for (let i = 0; i < PROP_COUNT; i += 1) {
      props[`p${String(i).padStart(2, '0')}`] = `v${seed}`;
    }
    return props;
  }

  it('caps a rollup-only range at MAX_BREAKDOWN_PROPS', async () => {
    const oldDay = addDays(TODAY, -RAW_RETENTION_DAYS - 5);
    await seedEvents([
      { day: oldDay, name: 'wide_event', installId: INSTALLS.a, sessionId: S1, props: wideProps(1) },
    ]);
    const { rollupStatements } = await import('../src/rollup.js');
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(oldDay).run();

    const body = await top(oldDay, oldDay);
    const props = new Set(body.rows.map((r) => r.prop));
    expect(props.size).toBe(MAX_BREAKDOWN_PROPS);
  });

  it('caps a mixed range, and picks the same props on both sides of the boundary', async () => {
    const oldDay = addDays(TODAY, -RAW_RETENTION_DAYS - 5);
    const recentDay = YESTERDAY;

    const { rollupStatements } = await import('../src/rollup.js');
    await seedEvents([
      { day: oldDay, name: 'wide_event', installId: INSTALLS.a, sessionId: S1, props: wideProps(1) },
    ]);
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(oldDay).run();

    await seedEvents([
      { day: recentDay, name: 'wide_event', installId: INSTALLS.b, sessionId: S2, props: wideProps(2) },
    ]);

    const mixed = await top(oldDay, recentDay);
    const mixedProps = [...new Set(mixed.rows.map((r) => r.prop))].sort();
    expect(mixedProps).toHaveLength(MAX_BREAKDOWN_PROPS);

    // And the prop SET is consistent with what each source alone would report —
    // every prop here has the same total, so the tiebreak (`prop` ascending) fully
    // determines the answer, and it must not depend on the range's sources.
    const rawOnly = await top(recentDay, recentDay);
    const rawProps = [...new Set(rawOnly.rows.map((r) => r.prop))].sort();
    expect(rawProps).toHaveLength(MAX_BREAKDOWN_PROPS);
    expect(mixedProps).toEqual(rawProps);
  });

  it('ranks by total count across BOTH sources, not per source', async () => {
    // `p99` appears only in the rollup half and is the single most frequent prop
    // over the range; a per-source cap that ranked raw first could drop it.
    const oldDay = addDays(TODAY, -RAW_RETENTION_DAYS - 5);
    const { rollupStatements } = await import('../src/rollup.js');

    await seedEvents(
      Array.from({ length: 5 }, (_, i) => ({
        day: oldDay,
        name: 'wide_event',
        installId: INSTALLS.a,
        sessionId: S1,
        props: { p99: `v${i}` },
      })),
    );
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(oldDay).run();

    await seedEvents([
      { day: YESTERDAY, name: 'wide_event', installId: INSTALLS.b, sessionId: S2, props: wideProps(9) },
    ]);

    const body = await top(oldDay, YESTERDAY);
    const props = new Set(body.rows.map((r) => r.prop));
    expect(props.size).toBe(MAX_BREAKDOWN_PROPS);
    expect(props.has('p99')).toBe(true);
  });
});

describe('the §8.2 breakdown past raw retention', () => {
  /**
   * The rollup branch of the breakdown aliased `is_null AS isNull`. `ISNULL` is a
   * postfix operator in SQLite, so that is a SYNTAX ERROR, not an alias — every
   * `/v1/events/top?name=` request whose range reached past raw retention
   * answered 500 with "Internal error. Retry with backoff.", which §7 tells a
   * client to retry. Nothing caught it because the suite only ever read
   * `/v1/summary` past the boundary; this asserts the actual rows.
   */
  it('serves prop values, bools and the null row from the rollups', async () => {
    const oldDay = addDays(TODAY, -RAW_RETENTION_DAYS - 5);

    await seedEvents([
      { day: oldDay, name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'analytics', cached: true } },
      { day: oldDay, name: 'project_opened', installId: INSTALLS.b, sessionId: S2, props: { section: 'analytics', cached: false } },
      // No `section` at all: §8.2 folds absent together with explicit JSON null.
      { day: oldDay, name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { cached: true } },
    ]);

    const { rollupStatements } = await import('../src/rollup.js');
    await DB.batch(rollupStatements(testEnv, oldDay, NOW.toISOString()));
    await DB.prepare(`DELETE FROM events WHERE day = ?1`).bind(oldDay).run();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      readRequest(
        '/v1/events/top',
        { projectId: PROJECT, from: oldDay, to: oldDay, name: 'project_opened' },
        READ_KEY,
      ),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows: Array<{ prop: string; value: unknown; count: number; installs: number }>;
    };

    // A JSON bool must come back as a JSON bool, not as SQLite's 1/0 — which is
    // what `value_type` is in the rollup primary key for.
    expect(body.rows).toEqual([
      { prop: 'cached', value: true, count: 2, installs: 1 },
      { prop: 'cached', value: false, count: 1, installs: 1 },
      { prop: 'section', value: 'analytics', count: 2, installs: 2 },
      // The null row is LAST within its prop, regardless of count (§8.2).
      { prop: 'section', value: null, count: 1, installs: 1 },
    ]);
  });
});
