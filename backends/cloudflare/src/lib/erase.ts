// Erasing one user's events — the core of `POST /v1/users/erase` (schema §8.4).
//
// An app that calls `identify(userID:)` (§2.5) links its events to an account,
// and an app that links them has to be able to honour "delete my account". This
// is that, as plain functions over a `D1Database`, so the hosted dashboard
// (same D1, different Worker) can run the identical statements the public
// endpoint runs — the same rule `queries.ts` follows for reads.
//
// What `userIdHash` is. The SDK never sends the app's account id: it sends
// `lowercaseHex(SHA256(UTF8(userID + installIdSalt)))` (Sources/Stats/
// StatsIdentityStore.swift, `hash(_:salt:)`), and that is what `events.user_id`
// holds. So the caller computes the same hash on its own server — the salt
// ships in the app and is not a secret by design — and passes it here. The
// backend never sees, and cannot recover, the account id itself.
//
// Two modes, both scoped to ONE project (§2.5: a `userId` MUST NOT be used to
// join across projects — the same hash in another project is untouched):
//
//   * `unlink` — `SET user_id = NULL`. The events stay and keep counting; only
//     their link to the account goes. Every rollup stays EXACT, because no
//     rollup has ever contained `user_id` (they are per-day install and event
//     counts), so nothing derived from these rows changes. What does change is
//     any raw-window USER figure (the dashboard's `COUNT(DISTINCT user_id)`):
//     this user stops being counted, which is the point.
//   * `delete` — the rows go. Rollups follow as far as they can: a day the
//     delete leaves with NO raw rows has its rollups (both `include_debug`
//     variants, all three tables) deleted in the same batch, because no later
//     pass would ever correct them — the nightly sweep only re-rolls days that
//     still have raw rows, so a stale rollup for an emptied day would resurface
//     as that day's answer the moment the day left the raw window. A day that
//     still has OTHER rows keeps its rollup until a re-roll recomputes it: the
//     nightly trailing re-roll for recent days, and the age-out re-roll when the
//     day leaves the raw window. Reads serve a day inside the raw window from
//     its raw rows, so the rollup is stale only until the next nightly pass
//     re-rolls it (recent days) or the day ages out (older days). Days below
//     the project's `raw_complete_from` (0007) are never cleared: they are
//     served from their rollups, which are the real history there.
//
//   * `unlink` is FINAL for the rows it touches: it removes the only thing that
//     tied them to the account, so a later `delete` for the same hash cannot
//     find them — it deletes only rows linked since (none, under the
//     tombstone). Choose `delete` first if the rows themselves must go.
//
// THE TOMBSTONE (`erased_users`, 0009). Erasing the rows already stored is not
// enough: the SDK can still hold events captured under the hash — a queue on
// disk for days, or events recorded just before `forgetUser()` — and a delete
// frees their `(project_id, install_id, seq)` identity, so a re-send would be
// stored again, re-linking the account. So every erase call upserts
// `(project_id, user_id, mode, erased_at)`, and ingest consults it once per
// batch that carries a `userId` (`erasedUserModes`): an `unlink` tombstone
// stores the event with `user_id` NULL, a `delete` tombstone drops the event
// (still acknowledged — §7 makes a 4xx a permanent drop the SDK would log as an
// error, and these events are being dropped on purpose).
//
//   * `delete` BEATS `unlink` for the tombstone's life: an unlink after a
//     delete keeps `mode = 'delete'`. The safer direction — a later unlink must
//     not let deleted data back in as unlinked rows — and the difference only
//     matters for events that had not arrived yet.
//   * BOUNDED. Ingest accepts an event of any age (a too-old `ts` is clamped
//     into the window, §10), so no age bound falls out of the wire contract; a
//     queue can in principle sit unsent for as long as the app is not opened.
//     The bound chosen is the project's raw-retention window plus
//     `ERASURE_TOMBSTONE_MARGIN_DAYS`, measured from the LAST erase call: the
//     hash is never kept longer than the project would have kept the raw events
//     themselves, plus a month. A queue held offline longer than that can
//     re-link (unlink mode) or re-store (delete mode) its own events — stated
//     in README §10 and schema §8.4 rather than hidden. `purgeExpiredErasures`
//     runs in the nightly job; ingest also ignores an expired tombstone, so a
//     purge that has not run yet changes nothing.
//
// `installs` is NEVER touched, in either mode. A row there is an install id and
// a first-seen day, with no `user_id` and nothing about the account. And the
// install is not the user's alone: it may have events from before `identify()`,
// or from another account signed in on the same device after a `reset()`.
// Deleting it would rewrite that install's first sighting — and every cohort
// and new-versus-returning figure built on it — for activity that was never
// linked to this account. Erasing an install is a separate obligation with its
// own tool (§13, `delete-install`). `batches` and `batch_context` are not
// touched either: neither carries a `user_id` or an `installId`, and both age
// out with the retention sweep.
//
// Bounded and resumable. D1 bounds the time one statement may run, and the
// database is shared with ingest, reads and the dashboard (D1 serialises
// queries), so the work is done in chunks of `chunkRows` and at most `maxChunks`
// of them per call. A call that stops at its budget answers `done: false`; the
// caller calls again. Every call works on "whatever is still linked", so a
// retry, a concurrent call or a rerun after `done` is harmless: IDEMPOTENT,
// with `affected: 0` once there is nothing left.
//
// Authorization is the CALLER's, as everywhere in `src/lib/`: `projectId` is
// assumed already authorized (the endpoint resolves an admin key and checks its
// scope first; the dashboard checks project ownership). The two values that
// could otherwise do something surprising — the hash and the mode — are
// validated here, so a consumer cannot erase by a malformed or empty id.
//
// The SQL is exported as constants because `scripts/admin.mjs delete-user`
// carries the same statements VERBATIM (it is dependency-free Node and cannot
// import TypeScript); test/erase.test.ts compares the texts, as
// test/retention.test.ts does for `set-retention`.

import { badRequest } from '../errors.js';
import { clampRetentionDays, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../dates.js';

/** What happens to the matched rows. */
export type EraseMode = 'unlink' | 'delete';

export const ERASE_MODES: readonly EraseMode[] = ['unlink', 'delete'];

/**
 * The `userId` shape the SDK emits: 64 lowercase hex — a SHA-256, §2.5.
 *
 * Stricter than §2.5's "opaque, ≤ 128 scalars" on purpose. Erase is a
 * destructive admin call whose input is computed by the caller, and the one
 * mistake it most needs to catch is a caller passing the RAW account id (or an
 * uppercase hex, or a hash without the salt's exact bytes, which no regex can
 * catch) — every one of which matches nothing and would otherwise answer
 * `done: true, affected: 0` as if the erasure had worked.
 */
export const USER_ID_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Rows per chunked statement.
 *
 * The dashboard's project-delete number, for its reason: small enough that one
 * statement — which also maintains every index on `events`, seven of them now —
 * finishes far inside D1's per-statement limit.
 */
export const ERASE_CHUNK_ROWS = 5_000;

/**
 * Chunks one call may run before it stops and answers `done: false`.
 *
 * Small, because the D1 database is shared and serialises queries: a call that
 * ran 100,000 row-writes back to back would hold up every ingest and read on the
 * deployment for its whole duration. 4 × 5,000 rows keeps one call short;
 * callers loop on `done` anyway, so a heavy user costs more calls, not longer
 * ones.
 */
export const MAX_ERASE_CHUNKS = 4;

/**
 * Days a tombstone outlives the project's raw-retention window (see the header).
 * A month: long enough for an app that was not opened for a few weeks to flush
 * its queue into a live tombstone, short enough that the hash is not kept
 * materially longer than the data it suppresses.
 */
export const ERASURE_TOMBSTONE_MARGIN_DAYS = 30;

/** Expired tombstones one nightly purge deletes (one statement). */
export const ERASURE_PURGE_ROWS = 5_000;

/** The rollup tables a delete clears for a day it empties. Literals, never input. */
export const ERASE_ROLLUP_TABLES = ['daily_rollups', 'daily_event_rollups', 'daily_prop_rollups'] as const;

/**
 * Record (or refresh) the tombstone. ?1 project, ?2 user hash, ?3 mode, ?4 now
 * (ISO 8601 ms Z). `delete` is sticky; `erased_at` always moves to the latest
 * call, so the bound runs from the last erase.
 */
export const ERASE_TOMBSTONE_SQL = `INSERT INTO erased_users (project_id, user_id, mode, erased_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (project_id, user_id) DO UPDATE
  SET mode = CASE WHEN erased_users.mode = 'delete' THEN 'delete' ELSE excluded.mode END,
      erased_at = excluded.erased_at`;

/**
 * The rows one chunk works on: ?1 project, ?2 user hash, ?3 chunk size. An
 * index range on `events_user` (0009, `(project_id, user_id) WHERE user_id IS
 * NOT NULL` — `user_id = ?` implies the partial index's condition). `ORDER BY
 * id` is that index's own order within one key, so it costs nothing and makes
 * every statement of one delete batch — the rollup clears and the delete —
 * name the SAME rows inside the batch's one transaction.
 */
const CHUNK_IDS = `SELECT id FROM events WHERE project_id = ?1 AND user_id = ?2 ORDER BY id LIMIT ?3`;

export const ERASE_UNLINK_SQL = `UPDATE events SET user_id = NULL WHERE id IN (${CHUNK_IDS})`;
export const ERASE_DELETE_SQL = `DELETE FROM events WHERE id IN (${CHUNK_IDS})`;

/**
 * Clear one rollup table for the days the delete chunk is ABOUT TO EMPTY. Same
 * binds as the chunk (?1 project, ?2 user hash, ?3 chunk size), and run in the
 * same batch immediately BEFORE `ERASE_DELETE_SQL`, so the days are computed in
 * SQL from the very rows the delete removes — nothing is read outside the
 * transaction, and a concurrent ingest or erase cannot change the answer
 * between the two. A day is cleared only if every raw row it has is in the
 * chunk (any other row — another user, another install, a debug event — keeps
 * it), and never below the project's `raw_complete_from` (0007): those days are
 * served from their rollups, the raw rows there are only late arrivals, and the
 * rollup is the real history. `{table}` is one of `ERASE_ROLLUP_TABLES`.
 */
export const ERASE_CLEAR_ROLLUPS_SQL = `DELETE FROM {table}
 WHERE project_id = ?1
   AND day IN (SELECT day FROM events WHERE id IN (${CHUNK_IDS}))
   AND day >= COALESCE((SELECT raw_complete_from FROM projects WHERE id = ?1), '')
   AND NOT EXISTS (SELECT 1 FROM events e
                    WHERE e.project_id = ?1 AND e.day = {table}.day
                      AND e.id NOT IN (${CHUNK_IDS}))`;

/**
 * Delete every tombstone past its bound, at most `ERASURE_PURGE_ROWS` a night.
 * ?1 = now (ISO 8601 ms Z). The bound is computed per project from its own
 * `retention_days`, clamped exactly as `clampRetentionDays` does. The first
 * predicate is the SHORTEST possible bound (minimum window + margin): implied by
 * the second, but sargable, so the nightly statement is a range on
 * `erased_users_by_time` holding only rows old enough to be candidates rather
 * than a pass over every tombstone.
 */
export const ERASURE_PURGE_SQL = `DELETE FROM erased_users
 WHERE rowid IN (
   SELECT t.rowid FROM erased_users t JOIN projects p ON p.id = t.project_id
    WHERE t.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?1,
            '-' || ${MIN_RETENTION_DAYS + ERASURE_TOMBSTONE_MARGIN_DAYS} || ' days')
      AND t.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?1,
            '-' || (max(${MIN_RETENTION_DAYS}, min(${MAX_RETENTION_DAYS}, COALESCE(p.retention_days, ${MIN_RETENTION_DAYS}))) + ${ERASURE_TOMBSTONE_MARGIN_DAYS}) || ' days')
    LIMIT ${ERASURE_PURGE_ROWS})`;

export interface EraseOptions {
  /** Overrides `ERASE_CHUNK_ROWS` — for tests. */
  readonly chunkRows?: number;
  /** Overrides `MAX_ERASE_CHUNKS` — for tests, or a caller sharing one budget. */
  readonly maxChunks?: number;
  /** The clock, for the tombstone's `erased_at`. Pass it in tests. */
  readonly now?: Date;
}

export interface EraseResult {
  /** True when no event in the project still carries this `userId`. */
  readonly done: boolean;
  /** Rows unlinked or deleted by THIS call. */
  readonly affected: number;
  /** Chunked statements this call issued, so a caller can share one budget. */
  readonly chunks: number;
}

/** Validate an erase mode, or throw 400 `invalid_mode`. Required, no default. */
export function parseEraseMode(raw: unknown): EraseMode {
  // No default, deliberately: the two modes differ in whether data survives,
  // and a caller that forgot to choose must not get either one silently.
  if (raw === 'unlink' || raw === 'delete') return raw;
  throw badRequest('invalid_mode', '`mode` is required and must be "unlink" or "delete".');
}

/** Validate a `userId` hash, or throw 400 `invalid_user_id`. */
export function parseUserIdHash(raw: unknown): string {
  if (typeof raw === 'string' && USER_ID_HASH_RE.test(raw)) return raw;
  throw badRequest(
    'invalid_user_id',
    '`userId` must be the 64-character lowercase hex SHA-256 the SDK sends, not the account id.',
  );
}

/**
 * Record the tombstone, then unlink or delete, in bounded chunks, every event in
 * `projectId` whose `user_id` is `userIdHash`. Call again while `done` is false.
 *
 * The tombstone goes FIRST, so from the first call on ingest stops adding rows
 * for the hash; rows a concurrent ingest committed just before it are still
 * linked, and the chunks — which the caller repeats until `done` — reach them.
 * SQLite on D1 has no `UPDATE/DELETE … LIMIT`, hence `id IN (SELECT …)`.
 * Unlinked rows leave `events_user` and deleted rows leave the table, so each
 * chunk starts on rows not yet erased and a short chunk means nothing is left.
 */
export async function eraseUserChunk(
  db: D1Database,
  projectId: string,
  userIdHash: string,
  mode: EraseMode,
  options: EraseOptions = {},
): Promise<EraseResult> {
  const hash = parseUserIdHash(userIdHash);
  const verb = parseEraseMode(mode);
  const chunkRows = Math.max(1, Math.floor(options.chunkRows ?? ERASE_CHUNK_ROWS));
  const budget = Math.max(1, Math.floor(options.maxChunks ?? MAX_ERASE_CHUNKS));
  const now = options.now ?? new Date();

  await db.prepare(ERASE_TOMBSTONE_SQL).bind(projectId, hash, verb, now.toISOString()).run();

  let affected = 0;
  let chunks = 0;
  while (chunks < budget) {
    chunks += 1;
    const changes =
      verb === 'unlink'
        ? (await db.prepare(ERASE_UNLINK_SQL).bind(projectId, hash, chunkRows).run()).meta.changes
        : await deleteChunk(db, projectId, hash, chunkRows);
    if (typeof changes !== 'number') {
      // D1 has always reported `changes`. If it ever stops, "short chunk ⇒ done"
      // cannot be decided from the result, and guessing `done: true` would tell
      // a caller an erasure finished when it may not have — the one wrong
      // answer this function must never give. Ask the table instead.
      return { done: !(await anyLeft(db, projectId, hash)), affected, chunks };
    }
    affected += changes;
    if (changes < chunkRows) return { done: true, affected, chunks };
  }
  // The budget ran out on a FULL chunk. There may be nothing left (the user had
  // an exact multiple of `chunkRows`); the next call finds out in one cheap
  // statement and answers `done: true, affected: 0`.
  return { done: false, affected, chunks };
}

/**
 * One delete chunk, as ONE batch (one transaction): clear the rollups of every
 * day the chunk empties, then delete the chunk. The clears go first because
 * they compute "the days this chunk empties" from the chunk's rows, which the
 * delete then removes.
 */
async function deleteChunk(
  db: D1Database,
  projectId: string,
  hash: string,
  chunkRows: number,
): Promise<number | undefined> {
  const results = await db.batch([
    ...ERASE_ROLLUP_TABLES.map((table) =>
      db.prepare(ERASE_CLEAR_ROLLUPS_SQL.replaceAll('{table}', table)).bind(projectId, hash, chunkRows),
    ),
    db.prepare(ERASE_DELETE_SQL).bind(projectId, hash, chunkRows),
  ]);
  return results[ERASE_ROLLUP_TABLES.length]?.meta.changes;
}

async function anyLeft(db: D1Database, projectId: string, hash: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS n FROM events WHERE project_id = ?1 AND user_id = ?2 LIMIT 1`)
    .bind(projectId, hash)
    .first<{ n: number }>();
  return row !== null;
}

/**
 * The oldest `erased_at` a live tombstone may have, for a project with this
 * window: `now` minus (clamped window + margin) days, ISO 8601 ms Z. A tombstone
 * at exactly this instant is still live.
 */
export function erasureCutoff(retentionDays: number, now: Date): string {
  const ttlDays = clampRetentionDays(retentionDays) + ERASURE_TOMBSTONE_MARGIN_DAYS;
  return new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
}

/**
 * Live tombstones for the `userId`s of one ingest batch: hash → mode.
 *
 * ONE statement however many distinct hashes the batch carries (they arrive as
 * one JSON array parameter), and the caller skips it entirely for a batch with
 * no `userId` — the common case costs nothing. A tombstone older than the
 * project's window plus the margin is ignored here even before the nightly
 * purge removes it, so the bound is exact rather than "whenever the job ran".
 */
export async function erasedUserModes(
  db: D1Database,
  projectId: string,
  userIds: readonly string[],
  retentionDays: number,
  now: Date,
): Promise<Map<string, EraseMode>> {
  const out = new Map<string, EraseMode>();
  if (userIds.length === 0) return out;
  const since = erasureCutoff(retentionDays, now);
  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, mode FROM erased_users
        WHERE project_id = ?1 AND erased_at >= ?2 AND user_id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(projectId, since, JSON.stringify(userIds))
    .all<{ userId: string; mode: EraseMode }>();
  for (const r of results) out.set(r.userId, r.mode);
  return out;
}

/** The nightly purge of expired tombstones. Returns rows deleted. */
export async function purgeExpiredErasures(db: D1Database, now: Date): Promise<number> {
  const result = await db.prepare(ERASURE_PURGE_SQL).bind(now.toISOString()).run();
  return result.meta.changes ?? 0;
}
