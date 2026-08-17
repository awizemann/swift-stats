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

export type KeyKind = 'write' | 'read';

export interface KeyScope {
  readonly projectId: string;
  readonly kind: KeyKind;
}

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
  const row = await db
    .prepare(
      `SELECT project_id AS projectId
         FROM keys
        WHERE key_hash = ?1
          AND kind = ?2
          AND revoked_at IS NULL`,
    )
    .bind(hash, kind)
    .first<{ projectId: string }>();

  if (row === null) throw unauthorized();
  return { projectId: row.projectId, kind };
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
