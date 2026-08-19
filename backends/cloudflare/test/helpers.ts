// Shared fixtures for the conformance suite.
//
// The suite runs against a real local D1 (miniflare), applying the real
// migration file — not a hand-written test schema. A test-only schema is how a
// backend's suite passes while the deployed migration is wrong.

import { env } from 'cloudflare:test';
import { hashKey } from '../src/keys.js';
import type { Env } from '../src/env.js';

export const DB = (env as unknown as Env).DB;

/** The real migration SQL, injected by vitest.config.ts (workerd has no fs). */
const MIGRATIONS_SQL = (env as unknown as { MIGRATIONS_SQL: string[] }).MIGRATIONS_SQL;

export const PROJECT = 'overwatch';
export const OTHER_PROJECT = 'someone-else';
export const WRITE_KEY = 'sk_stats_TEST_WRITE_KEY_0000000000000001';
export const READ_KEY = 'rk_stats_TEST_READ_KEY_00000000000000001';
export const OTHER_WRITE_KEY = 'sk_stats_TEST_WRITE_KEY_0000000000000002';
export const OTHER_READ_KEY = 'rk_stats_TEST_READ_KEY_00000000000000002';
export const REVOKED_WRITE_KEY = 'sk_stats_TEST_REVOKED_000000000000000001';

const INSTALL_A = 'a'.repeat(64);
const INSTALL_B = 'b'.repeat(64);
export const INSTALLS = { a: INSTALL_A, b: INSTALL_B };

const TABLES = [
  'events',
  'installs',
  'batch_context',
  'batches',
  'daily_rollups',
  'daily_event_rollups',
  'daily_prop_rollups',
  'rollup_state',
  'rollup_lease',
  'keys',
  'projects',
  'rollup_state',
];

/**
 * Drop everything, apply every migration in order, then seed projects and keys.
 *
 * Applying the REAL migration files (not a hand-written test schema) is the
 * point: a suite that builds its own tables passes while the migration that
 * ships is wrong, which is the failure mode this is guarding against.
 */
export async function resetDatabase(): Promise<void> {
  for (const table of TABLES) {
    await DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }

  for (const file of MIGRATIONS_SQL) {
    // Strip every `--` comment before splitting. The migration is heavily
    // commented and a comment containing a `;` would otherwise split a statement
    // in half. Safe here because no string literal in the migration contains `--`.
    const sql = file.replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed !== '') await DB.prepare(trimmed).run();
    }
  }

  const now = '2026-08-17T00:00:00.000Z';
  await DB.batch([
    DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, 'Overwatch', ?2)`).bind(PROJECT, now),
    DB.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?1, 'Other', ?2)`).bind(OTHER_PROJECT, now),
  ]);

  const seed = async (key: string, project: string, kind: 'write' | 'read', revoked: string | null) => {
    await DB.prepare(
      `INSERT INTO keys (key_hash, project_id, kind, label, created_at, revoked_at)
       VALUES (?1, ?2, ?3, 'test', ?4, ?5)`,
    )
      .bind(await hashKey(key), project, kind, now, revoked)
      .run();
  };

  await seed(WRITE_KEY, PROJECT, 'write', null);
  await seed(READ_KEY, PROJECT, 'read', null);
  await seed(OTHER_WRITE_KEY, OTHER_PROJECT, 'write', null);
  await seed(OTHER_READ_KEY, OTHER_PROJECT, 'read', null);
  await seed(REVOKED_WRITE_KEY, PROJECT, 'write', '2026-08-16T00:00:00.000Z');
}

/** Set a project's raw-retention window (migration 0006). */
export async function setRetention(projectId: string, days: number): Promise<void> {
  await DB.prepare(`UPDATE projects SET retention_days = ?2 WHERE id = ?1`)
    .bind(projectId, days)
    .run();
}

/** `keys.last_used_at` for a presented key, by hash (migration 0004). */
export async function lastUsedAt(key: string): Promise<string | null> {
  const row = await DB.prepare(`SELECT last_used_at AS v FROM keys WHERE key_hash = ?1`)
    .bind(await hashKey(key))
    .first<{ v: string | null }>();
  return row?.v ?? null;
}

/** Overwrite `keys.last_used_at`, to fake the passage of time in a test. */
export async function setLastUsed(key: string, iso: string | null): Promise<void> {
  await DB.prepare(`UPDATE keys SET last_used_at = ?2 WHERE key_hash = ?1`)
    .bind(await hashKey(key), iso)
    .run();
}

/** Seed `installs` rows directly, for cohort-read fixtures (migration 0005). */
export async function seedInstalls(
  rows: Array<{ installId: string; firstSeenDay: string; projectId?: string }>,
): Promise<void> {
  await DB.batch(
    rows.map((r) =>
      DB.prepare(
        `INSERT OR IGNORE INTO installs (project_id, install_id, first_seen_day)
         VALUES (?1, ?2, ?3)`,
      ).bind(r.projectId ?? PROJECT, r.installId, r.firstSeenDay),
    ),
  );
}

let uuidCounter = 0;
let nextSeedSeq = 0;

/** Deterministic, distinct, uppercase RFC 4122 UUIDs. */
export function batchId(n?: number): string {
  const i = n ?? (uuidCounter += 1);
  const hex = i.toString(16).padStart(12, '0').toUpperCase();
  return `8B0B8AF0-3E9F-4F9F-9F1D-${hex}`;
}

export interface EventOverrides {
  name?: string;
  ts?: string;
  sessionId?: string;
  installId?: string;
  appId?: string;
  projectId?: string | null;
  seq?: number;
  userId?: string;
  props?: Record<string, unknown> | null;
}

export function makeEvent(o: EventOverrides = {}): Record<string, unknown> {
  const e: Record<string, unknown> = {
    name: o.name ?? 'project_opened',
    ts: o.ts ?? '2026-08-17T14:03:11.482Z',
    sessionId: o.sessionId ?? '1786012978-40371852',
    installId: o.installId ?? INSTALL_A,
    appId: o.appId ?? 'com.wizemann.Overwatch',
    seq: o.seq ?? 41,
  };
  if (o.projectId !== null && o.projectId !== undefined) e.projectId = o.projectId;
  if (o.userId !== undefined) e.userId = o.userId;
  if (o.props !== undefined && o.props !== null) e.props = o.props;
  return e;
}

export function makeContext(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sdkVersion: '0.1.0',
    appVersion: '1.4.2',
    appBuild: '318',
    bundleId: 'com.wizemann.Overwatch',
    osName: 'macOS',
    osVersion: '15.4.1',
    deviceModel: 'Mac15,3',
    arch: 'arm64',
    locale: 'en_US',
    region: 'US',
    screenWidth: 1512,
    screenHeight: 982,
    screenScale: 2.0,
    isDebug: false,
    isTestFlight: false,
    colorScheme: 'dark',
    ...o,
  };
}

export function makeBatch(o: {
  batchId?: string;
  sentAt?: string;
  schema?: unknown;
  context?: Record<string, unknown>;
  events?: unknown[];
} = {}): Record<string, unknown> {
  return {
    // `'schema' in o` rather than `??`, so a case can assert on a MISSING
    // `schema` by passing `{ schema: undefined }` — with `??` that silently
    // became a valid "v1" and the test asserted nothing.
    schema: 'schema' in o ? o.schema : 'v1',
    batchId: o.batchId ?? batchId(),
    sentAt: o.sentAt ?? '2026-08-17T14:03:12.004Z',
    context: o.context ?? makeContext(),
    events: o.events ?? [makeEvent()],
  };
}

export function ingestRequest(
  body: unknown,
  init: { key?: string | null; contentType?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers ?? {});
  const contentType = init.contentType === undefined ? 'application/json; charset=utf-8' : init.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  const key = init.key === undefined ? WRITE_KEY : init.key;
  if (key !== null) headers.set('x-stats-key', key);
  return new Request('https://stats.example.com/v1/events', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function readRequest(
  path: string,
  params: Record<string, string>,
  key: string | null = READ_KEY,
): Request {
  const url = new URL(`https://stats.example.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = new Headers();
  if (key !== null) headers.set('x-stats-read-key', key);
  return new Request(url, { method: 'GET', headers });
}

/** Insert raw event rows directly, for read-path fixtures. */
export async function seedEvents(
  rows: Array<{
    day: string;
    ts?: string;
    name: string;
    installId: string;
    sessionId: string;
    props?: Record<string, unknown> | null;
    isDebug?: boolean;
    projectId?: string;
  }>,
): Promise<void> {
  const bid = batchId();
  const seedSeq = nextSeedSeq;
  nextSeedSeq += rows.length;
  await DB.prepare(
    `INSERT OR IGNORE INTO batches (batch_id, project_id, received_at, event_count) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(bid, PROJECT, '2026-08-17T00:00:00.000Z', rows.length)
    .run();

  // `seq` is drawn from a suite-global counter, never from the row index.
  // Migration 0003 makes (project_id, install_id, seq) UNIQUE, and two
  // `seedEvents` calls in one test both starting at 0 for the same install
  // would collide — a fixture artefact, not the behaviour under test.
  const stmt = DB.prepare(
    `INSERT INTO events
       (project_id, batch_id, day, ts, name, session_id, install_id, app_id, seq, user_id, props, is_debug)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'com.wizemann.Overwatch', ?8, NULL, ?9, ?10)`,
  );

  await DB.batch(
    rows.map((r, i) =>
      stmt.bind(
        r.projectId ?? PROJECT,
        bid,
        r.day,
        r.ts ?? `${r.day}T12:00:00.000Z`,
        r.name,
        r.sessionId,
        r.installId,
        seedSeq + i,
        r.props === undefined || r.props === null ? null : JSON.stringify(r.props),
        r.isDebug === true ? 1 : 0,
      ),
    ),
  );
}
