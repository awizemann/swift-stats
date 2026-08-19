// Key handling.
//
// A key is a 32-byte random value, presented as `<prefix>_<base64url>`. Only its
// SHA-256 is ever stored (table `keys`), so a D1 dump does not yield a usable
// key and the plaintext exists exactly once, in the operator's terminal at mint
// time.
//
// On constant-time comparison: there is none here, and none is needed. We do not
// compare a stored secret against a presented one; we hash the presented key and
// do an indexed equality lookup on the hash. A timing signal from that lookup
// leaks at most something about the *hash*, and inverting SHA-256 to turn that
// into a key is the thing SHA-256 is for. What WOULD need a constant-time
// compare is storing keys in plaintext (or in a Worker secret) and using `===`;
// that design is the reason this one exists.

import { unauthorized } from './errors.js';
import { clampRetentionDays } from './dates.js';
import { logger } from './log.js';

export type KeyKind = 'write' | 'read';

export interface KeyScope {
  readonly projectId: string;
  readonly kind: KeyKind;
  /** The project's raw-event window in days (0006), already clamped. */
  readonly retentionDays: number;
  /**
   * SHA-256 of the presented key — the same value stored in `keys.key_hash`.
   *
   * Carried so `touchKey` needs no second hash and no second lookup. It is a key
   * identifier: it must never be logged, returned, or put in an error (src/log.ts
   * enforces the first mechanically).
   */
  readonly keyHash: string;
  /** `keys.last_used_at` as it was at auth time; `null` = never seen. */
  readonly lastUsedAt: string | null;
}

/**
 * How stale `last_used_at` must be before a request rewrites it.
 *
 * The column answers "is anything still using this key?", a question whose useful
 * granularity is hours. Writing it on every request would turn a key doing 100
 * rps into 100 rows written per second — D1 bills rows written — to service a
 * diagnostic. At 60 seconds the answer is far finer than the question and the
 * cost is bounded at one write per key per minute regardless of traffic.
 */
export const KEY_TOUCH_INTERVAL_MS = 60_000;

/** Prefixes, so a leaked string is recognizable in a log or a bug report. */
export const WRITE_KEY_PREFIX = 'sk_stats';
export const READ_KEY_PREFIX = 'rk_stats';

/** Lowercase hex SHA-256 of a key's UTF-8 bytes. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve a presented key to its scope, or throw 401.
 *
 * `kind` is checked in SQL rather than after the fetch, so a *write* key
 * presented to a read endpoint produces exactly the same 401 as an unknown key
 * — schema §8 requires that a write key grant no reads, and §8 also requires
 * that nothing in the response distinguish the failure modes.
 *
 * A revoked key (`revoked_at IS NOT NULL`) is excluded here rather than deleted
 * at revocation time, so that `keys` remains an audit trail of what was ever
 * minted for a project.
 */
export async function resolveKey(
  db: D1Database,
  presented: string | null,
  kind: KeyKind,
): Promise<KeyScope> {
  // Reject before touching the database: no key, or a length that cannot be one.
  // This also means an empty `X-Stats-Key` header costs no D1 read.
  if (presented === null || presented.length < 8 || presented.length > 256) {
    throw unauthorized();
  }

  const hash = await hashKey(presented);
  // The project's retention window and the key's `last_used_at` come back on the
  // SAME row as the scope. Both are needed on every authenticated request — the
  // window decides day bucketing and read routing (0006), `last_used_at` decides
  // whether this request rewrites it (0004) — and fetching them here costs
  // nothing over the lookup that was already happening. Two extra SELECTs per
  // request would have been a real cost for two columns.
  const row = await db
    .prepare(
      `SELECT k.project_id AS projectId,
              k.last_used_at AS lastUsedAt,
              p.retention_days AS retentionDays
         FROM keys k
         JOIN projects p ON p.id = k.project_id
        WHERE k.key_hash = ?1
          AND k.kind = ?2
          AND k.revoked_at IS NULL`,
    )
    .bind(hash, kind)
    .first<{ projectId: string; lastUsedAt: string | null; retentionDays: number | null }>();

  // The JOIN also means a key whose project has been deleted is a 401 rather than
  // a crash — which is what the `keys.project_id` cascade already made true in
  // practice, now stated in the query.
  if (row === null) throw unauthorized();
  return {
    projectId: row.projectId,
    kind,
    retentionDays: clampRetentionDays(row.retentionDays),
    keyHash: hash,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Record that this key was used, at most once per `KEY_TOUCH_INTERVAL_MS`.
 *
 * Called on both the ingest and the read paths after authentication succeeds, so
 * an operator mid-rotation can see whether the key they are about to revoke is
 * still carrying traffic (README §7). A revoked key never reaches here: it does
 * not resolve, so `last_used_at` freezes at the last live use — which is the
 * value that makes the audit trail worth having.
 *
 * Two independent guards on the write, and both are wanted:
 *
 *   * The in-memory check skips the statement entirely for the common case, so a
 *     busy key costs zero extra rows written.
 *   * The `WHERE` re-asserts the same condition in SQL, so two concurrent
 *     requests that both read a stale value cannot both write, and so a key that
 *     was revoked between the lookup and this statement is not resurrected in the
 *     `last_used_at` column.
 *
 * Never throws. A failure to record a diagnostic timestamp must not turn a valid
 * batch into a 5xx the emitter will retry, so the error is swallowed after being
 * logged WITHOUT the hash (§ "Logging": no key, no key hash, ever).
 */
export async function touchKey(db: D1Database, scope: KeyScope, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - KEY_TOUCH_INTERVAL_MS);
  if (scope.lastUsedAt !== null) {
    const previous = Date.parse(scope.lastUsedAt);
    // `NaN` (an unparseable stored value) falls through to the write, which
    // replaces it with a well-formed one.
    if (!Number.isNaN(previous) && previous > staleBefore.getTime()) return false;
  }

  try {
    const result = await db
      .prepare(
        `UPDATE keys
            SET last_used_at = ?2
          WHERE key_hash = ?1
            AND revoked_at IS NULL
            AND (last_used_at IS NULL OR last_used_at <= ?3)`,
      )
      .bind(scope.keyHash, now.toISOString(), staleBefore.toISOString())
      .run();
    return (result.meta.changes ?? 0) > 0;
  } catch (cause) {
    logger.error('key_touch_failed', { projectId: scope.projectId }, cause);
    return false;
  }
}

/**
 * Validate a client-asserted `projectId` against the key's scope.
 *
 * Used on the read path (§8): the query parameter is validated, never trusted,
 * and a project the key does not cover is a 401 that looks exactly like a
 * nonexistent project. We never SELECT from `projects` to answer this — doing so
 * is how a backend accidentally grows a 404-vs-401 distinction that leaks the
 * existence of other tenants.
 */
export function requireScope(scope: KeyScope, requestedProjectId: string): void {
  if (requestedProjectId !== scope.projectId) throw unauthorized();
}

/** Mint a fresh key. Returned plaintext is the only copy; store `hash` only. */
export async function mintKey(kind: KeyKind): Promise<{ key: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const key = `${kind === 'write' ? WRITE_KEY_PREFIX : READ_KEY_PREFIX}_${b64}`;
  return { key, hash: await hashKey(key) };
}
