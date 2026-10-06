-- swift-stats Cloudflare/D1 backend — migration 0009.
--
-- Three additive changes for `POST /v1/users/erase` (schema §8.4): honouring an
-- app's "delete my account" for the events it linked with `identify()` (§2.5).
--
-- 1. `keys.kind` gains 'admin'.
--
--    An admin key (`ak_stats_…`) grants exactly one thing — erasing one user's
--    events within its project — and nothing else: it 401s on ingest and on the
--    read endpoints, and write and read keys 401 on erase, byte-identically
--    (§8). It is a third kind rather than a capability of the read key because
--    the two live in different places: a read key sits in a dashboard or a
--    script, an admin key sits on the app's own SERVER next to its account
--    deletion code, and neither should be able to do the other's job.
--
--    SQLite cannot alter a CHECK constraint, so `keys` is rebuilt and renamed —
--    the same rebuild 0002 did for the rollup tables and 0008 for the raw ones.
--    Every column, type, constraint, STRICT and the one index are carried over
--    unchanged, in 0001's column order with 0004's `last_used_at` last where its
--    ALTER put it; only the CHECK's list is new. Rows are copied verbatim, so no
--    key changes behaviour: a write key still writes, a revoked key stays
--    revoked, and `last_used_at` keeps its value.
--
--    Orphans are dropped, not copied, exactly as 0008 does it: a `keys` row
--    whose project is gone cannot be inserted under the foreign key, and it
--    already 401s (`resolveKey` JOINs `projects`). `keys` has had that foreign
--    key since 0001, so on a database that has always enforced it there are
--    none to drop.
--
--    NOTHING REFERENCES `keys` — not here, and not in the hosted dashboard's
--    `app_*` migrations, which share this D1 and only ever
--    `DELETE FROM keys WHERE project_id = ?` and count it by `kind`. So dropping
--    it cannot cascade into anything, needs no `PRAGMA defer_foreign_keys`, and
--    those statements keep working against the rebuilt table by the same name.
--    `keys` is small (a few rows per project), so the copy is cheap.
--
-- 2. A partial index for finding one user's events.
--
--    `events_user` covers `(project_id, user_id)` for rows that HAVE a user and
--    no others. Erase is the only reader: without it, "every event of this user
--    in this project" is a scan of the project's whole `(project_id, day)` range.
--    Partial, because most events carry no `user_id` (§2.5: only after the app
--    calls `identify()`), so indexing the NULLs would cost every un-identified
--    ingest an index write for nothing. It also makes unlink's chunks cheap by
--    construction: a row set to NULL leaves the index, so the next chunk's
--    `LIMIT` starts on rows not yet unlinked.
--
--    project_id first, so the lookup can never range across tenants (§2.5: a
--    `userId` MUST NOT be used to join across projects).
--
-- 3. `erased_users` — the erase tombstone.
--
--    Erasing the stored rows does not stop the SDK from sending more under the
--    same hash: a queue can sit on a device for days, and a delete frees the
--    `(project_id, install_id, seq)` identity, so a re-send would be stored
--    again. Each erase call upserts one row here, and ingest looks the batch's
--    `userId`s up in it (one statement per batch, and only for a batch that
--    carries a `userId`): `unlink` stores the event with no `user_id`, `delete`
--    drops it. `delete` is sticky over a later `unlink`.
--
--    It holds the hash, which is the thing being erased — so it is BOUNDED: a
--    tombstone counts only for the project's raw-retention window plus 30 days
--    after the last erase call, and the nightly job deletes it after that
--    (src/lib/erase.ts, `ERASURE_PURGE_SQL`). The hash is never kept, for this
--    purpose, materially longer than the raw events it stands in for would have
--    been. Cascades with its project like everything else a project owns;
--    `erased_users_by_time` keeps the nightly purge an index range.

CREATE TABLE keys_v2 (
  key_hash      TEXT PRIMARY KEY,          -- lowercase hex SHA-256 of the key
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('write', 'read', 'admin')),
  label         TEXT,                      -- operator note, e.g. "Overwatch macOS 1.4"
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,                      -- NULL = live; any value = rejected 401
  last_used_at  TEXT                       -- 0004: ISO 8601 UTC ms; NULL = never seen
) STRICT;

INSERT INTO keys_v2 (key_hash, project_id, kind, label, created_at, revoked_at, last_used_at)
SELECT key_hash, project_id, kind, label, created_at, revoked_at, last_used_at
  FROM keys
 WHERE project_id IN (SELECT id FROM projects);

DROP TABLE keys;

ALTER TABLE keys_v2 RENAME TO keys;

-- 0001's index, by its original name.
CREATE INDEX keys_by_project ON keys (project_id, kind);

CREATE INDEX events_user ON events (project_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE erased_users (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,             -- the wire `userId` hash (§2.5)
  mode        TEXT NOT NULL CHECK (mode IN ('unlink', 'delete')),
  erased_at   TEXT NOT NULL,             -- ISO 8601 UTC ms of the LAST erase call
  PRIMARY KEY (project_id, user_id)
) STRICT;

CREATE INDEX erased_users_by_time ON erased_users (erased_at);
