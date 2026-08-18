// `src/lib/queries.ts` — the reusable read layer, exercised WITHOUT HTTP.
//
// Why this file exists separately from `read.test.ts`: the whole point of the
// lib is that a sibling Worker (the swiftstats.co dashboard, bound to the same
// D1) can call these functions directly and get the public API's numbers. The
// conformance suite goes through `worker.fetch`, so it pins the endpoints but
// not the module's own surface — nothing there would notice if the direct-call
// entry points drifted, took different defaults, or grew a dependency on a
// `Request`. These cases call the exports the way the dashboard will.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { addDays, today } from '../src/dates.js';
import {
  byteCompare,
  clampAndValidateDays,
  DEFAULT_LIMIT,
  MAX_BREAKDOWN_PROPS,
  parseEventName,
  parseIncludeDebug,
  parseLimit,
  propBreakdown,
  rangeSource,
  rawBoundaryDay,
  requireBothDays,
  resolveDayRange,
  resolveRange,
  summary,
  summaryRows,
  topEvents,
} from '../src/lib/queries.js';
import { HttpError } from '../src/errors.js';
import type { Env } from '../src/env.js';
import { INSTALLS, PROJECT, resetDatabase, seedEvents } from './helpers.js';

const DB = (env as unknown as Env).DB;

const TODAY = today(new Date());
const D = (daysAgo: number): string => addDays(TODAY, -daysAgo);
const S1 = '1786012978-40371852';

/** The clock is a parameter everywhere in the lib; this is the proof. */
const NOW = new Date(`${TODAY}T12:00:00.000Z`);

beforeEach(async () => {
  await resetDatabase();
});

describe('the module boundary', () => {
  it('exposes the documented caps as values a consumer can read', () => {
    // A dashboard that renders "top 20 props" must not hard-code 20.
    expect(MAX_BREAKDOWN_PROPS).toBe(20);
    expect(DEFAULT_LIMIT).toBe(20);
  });
});

describe('clampAndValidateDays (pure, no database)', () => {
  it('clamps a future `to` to today', () => {
    expect(clampAndValidateDays(TODAY, '2099-12-31', NOW)).toEqual({ from: TODAY, to: TODAY });
  });

  it('leaves a past range alone', () => {
    expect(clampAndValidateDays(D(9), D(5), NOW)).toEqual({ from: D(9), to: D(5) });
  });

  it('throws invalid_range for a reversed range, a bad day, and a bad shape', () => {
    for (const [from, to] of [
      [D(5), D(9)],
      ['2026-02-30', '2026-02-30'],
      ['not-a-date', TODAY],
    ] as const) {
      expect(() => clampAndValidateDays(from, to, NOW)).toThrowError(HttpError);
      try {
        clampAndValidateDays(from, to, NOW);
      } catch (e) {
        expect((e as HttpError).status).toBe(400);
        expect((e as HttpError).code).toBe('invalid_range');
      }
    }
  });

  it('throws range_too_large at 401 days and accepts exactly 400', () => {
    expect(() => clampAndValidateDays(D(400), TODAY, NOW)).toThrowError(/at most 400 days/);
    expect(clampAndValidateDays(D(399), TODAY, NOW).from).toBe(D(399));
  });

  it('rejects a wholly-future range after clamping, rather than inventing zeros', () => {
    const soon = addDays(TODAY, 5);
    const later = addDays(TODAY, 9);
    // `to` clamps to today, which is now before `from` -> 400.
    expect(() => clampAndValidateDays(soon, later, NOW)).toThrowError(HttpError);
  });
});

describe('parameter parsing (pure, no database)', () => {
  it('parseIncludeDebug defaults to false and rejects anything but true/false', () => {
    expect(parseIncludeDebug(null)).toBe(false);
    expect(parseIncludeDebug('true')).toBe(true);
    expect(parseIncludeDebug('false')).toBe(false);
    for (const bad of ['yes', '1', 'TRUE', '']) {
      expect(() => parseIncludeDebug(bad), bad).toThrowError(HttpError);
    }
  });

  it('parseLimit defaults to 20 and rejects non-integers and out-of-range values', () => {
    expect(parseLimit(null)).toBe(20);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('100')).toBe(100);
    for (const bad of ['0', '101', '-1', 'abc', '20.0', '2e1', '']) {
      try {
        parseLimit(bad);
        throw new Error(`limit=${bad} should have thrown`);
      } catch (e) {
        expect((e as HttpError).code, bad).toBe('invalid_limit');
      }
    }
  });

  it('parseEventName passes a valid name through and rejects a malformed one', () => {
    expect(parseEventName(null)).toBeNull();
    expect(parseEventName('project_opened')).toBe('project_opened');
    for (const bad of ['Not A Name', '_leading', '9start', 'has-dash']) {
      expect(() => parseEventName(bad), bad).toThrowError(HttpError);
    }
  });

  it('requireBothDays demands both ends', () => {
    expect(requireBothDays(D(3), D(1))).toEqual({ from: D(3), to: D(1) });
    expect(() => requireBothDays(D(3), null)).toThrowError(HttpError);
    expect(() => requireBothDays(null, D(1))).toThrowError(HttpError);
  });
});

describe('resolveDayRange raw/rollup routing (pure, no database)', () => {
  const at = (from: string, to: string, boundary: string) =>
    resolveDayRange({ projectId: PROJECT, from, to }, boundary, NOW);

  it('routes a range wholly inside raw retention to raw only', () => {
    const r = at(D(10), D(2), D(89));
    expect(r.rawFrom).toBe(D(10));
    expect(r.rollupTo).toBeNull();
    expect(rangeSource(r)).toBe('raw');
  });

  it('routes a range wholly older than the boundary to the rollups only', () => {
    const r = at(D(300), D(200), D(89));
    expect(r.rawFrom).toBeNull();
    expect(r.rollupTo).toBe(D(200));
    expect(rangeSource(r)).toBe('rollup');
  });

  it('splits a straddling range at the boundary, disjoint and complete', () => {
    const r = at(D(200), D(2), D(89));
    // Raw covers [boundary, to]; rollups cover [from, boundary - 1]. The two
    // halves must meet exactly: no day counted twice, no day dropped.
    expect(r.rawFrom).toBe(D(89));
    expect(r.rollupTo).toBe(D(90));
    expect(addDays(r.rollupTo as string, 1)).toBe(r.rawFrom);
    expect(rangeSource(r)).toBe('mixed');
  });

  it('starts raw at the range start when the range begins after the boundary', () => {
    expect(at(D(50), D(2), D(89)).rawFrom).toBe(D(50));
  });

  it('carries includeDebug through, defaulting to false', () => {
    expect(at(D(3), D(1), D(89)).includeDebug).toBe(false);
    expect(
      resolveDayRange({ projectId: PROJECT, from: D(3), to: D(1), includeDebug: true }, D(89), NOW)
        .includeDebug,
    ).toBe(true);
  });
});

describe('rawBoundaryDay (observed state, not the clock)', () => {
  it('falls back to the clock cutoff for a project with no raw rows', async () => {
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(D(89));
  });

  it('moves the boundary DOWN to an unswept day older than the clock cutoff', async () => {
    // The 00:00–02:10 UTC window: `today` has ticked over, the sweep has not
    // run, and day 90 still has all its raw rows. Reading it from the rollups
    // could report a confident zero.
    await seedEvents([{ day: D(92), name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(D(92));
  });

  it('never moves the boundary UP past the clock cutoff', async () => {
    // A new or quiet project whose oldest raw row is recent must still have its
    // older days served from rollups, not reported as zero.
    await seedEvents([{ day: D(3), name: 'app_open', installId: INSTALLS.a, sessionId: S1 }]);
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(D(89));
  });

  it('is scoped to the project', async () => {
    await seedEvents([
      { day: D(92), name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: 'someone-else' },
    ]);
    expect(await rawBoundaryDay(DB, PROJECT, NOW)).toBe(D(89));
  });
});

describe('direct calls return the endpoint numbers', () => {
  beforeEach(async () => {
    await seedEvents([
      { day: D(4), name: 'app_open', installId: INSTALLS.a, sessionId: S1 },
      { day: D(4), name: 'app_open', installId: INSTALLS.b, sessionId: S1 },
      { day: D(4), name: 'project_opened', installId: INSTALLS.a, sessionId: S1, props: { section: 'analytics' } },
      { day: D(4), name: 'project_opened', installId: INSTALLS.b, sessionId: S1, props: { section: null } },
      { day: D(3), name: 'app_open', installId: INSTALLS.a, sessionId: S1, isDebug: true },
    ]);
  });

  it('summary() zero-fills and keys sessions on (installId, sessionId)', async () => {
    const { range, rows } = await summary(DB, {
      projectId: PROJECT, from: D(4), to: D(2), now: NOW,
    });
    expect(range.includeDebug).toBe(false);
    expect(rows).toEqual([
      // Installs A and B share sessionId S1 on the same day -> 2 sessions, not 1.
      { date: D(4), opens: 2, sessions: 2, activeInstalls: 2, events: 4 },
      { date: D(3), opens: 0, sessions: 0, activeInstalls: 0, events: 0 },
      { date: D(2), opens: 0, sessions: 0, activeInstalls: 0, events: 0 },
    ]);
  });

  it('summary() honours includeDebug', async () => {
    const { rows } = await summary(DB, {
      projectId: PROJECT, from: D(3), to: D(3), includeDebug: true, now: NOW,
    });
    expect(rows[0]).toMatchObject({ opens: 1, events: 1 });
  });

  it('summary() echoes the SERVED range after clamping', async () => {
    const { range } = await summary(DB, {
      projectId: PROJECT, from: TODAY, to: '2099-12-31', now: NOW,
    });
    expect(range.to).toBe(TODAY);
  });

  it('topEvents() ranks by count desc then name ascending, and defaults limit to 20', async () => {
    const { rows } = await topEvents(DB, { projectId: PROJECT, from: D(4), to: D(2), now: NOW });
    expect(rows).toEqual([
      { name: 'app_open', count: 2, installs: 2 },
      { name: 'project_opened', count: 2, installs: 2 },
    ]);
  });

  it('topEvents() honours an explicit limit', async () => {
    const { rows } = await topEvents(DB, {
      projectId: PROJECT, from: D(4), to: D(2), limit: 1, now: NOW,
    });
    expect(rows).toHaveLength(1);
  });

  it('propBreakdown() folds explicit-null and absent into one trailing null row', async () => {
    const { rows } = await propBreakdown(DB, {
      projectId: PROJECT, from: D(4), to: D(2), name: 'project_opened', now: NOW,
    });
    expect(rows).toEqual([
      { prop: 'section', value: 'analytics', count: 1, installs: 1 },
      { prop: 'section', value: null, count: 1, installs: 1 },
    ]);
  });

  it('sees no other project’s events', async () => {
    await seedEvents([
      { day: D(4), name: 'app_open', installId: INSTALLS.a, sessionId: S1, projectId: 'someone-else' },
    ]);
    const { rows } = await summary(DB, { projectId: PROJECT, from: D(4), to: D(4), now: NOW });
    expect(rows[0]).toMatchObject({ activeInstalls: 2, events: 4 });
  });

  it('is safe: a read writes nothing', async () => {
    const count = async () =>
      (await DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>())?.n;
    const before = await count();
    await summary(DB, { projectId: PROJECT, from: D(4), to: D(2), now: NOW });
    await topEvents(DB, { projectId: PROJECT, from: D(4), to: D(2), now: NOW });
    await propBreakdown(DB, {
      projectId: PROJECT, from: D(4), to: D(2), name: 'project_opened', now: NOW,
    });
    expect(await count()).toBe(before);
  });

  it('summaryRows() accepts a range resolved separately, for a caller that reuses one', async () => {
    // The dashboard resolves the boundary once and runs several queries over it.
    const range = await resolveRange(DB, { projectId: PROJECT, from: D(4), to: D(4) }, NOW);
    expect(await summaryRows(DB, range)).toEqual([
      { date: D(4), opens: 2, sessions: 2, activeInstalls: 2, events: 4 },
    ]);
  });
});

describe('byteCompare', () => {
  it('orders byte-wise over UTF-8, not by UTF-16 code unit', () => {
    expect(byteCompare('a', 'b')).toBeLessThan(0);
    expect(byteCompare('a', 'a')).toBe(0);
    expect(byteCompare('ab', 'a')).toBeGreaterThan(0);
    // U+FF3A (3 UTF-8 bytes, one UTF-16 unit) vs U+1D400 (4 bytes, a surrogate
    // pair). UTF-16 comparison puts the surrogate pair first; UTF-8 does not.
    expect(byteCompare('Ｚ', '\u{1D400}')).toBeLessThan(0);
  });
});
