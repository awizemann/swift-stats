-- swift-stats Cloudflare/D1 backend — migration 0002.
--
-- Two independent fixes, both from the pre-release audit. 0001 is applied on the
-- reference deployment, so it is not edited; this file is additive.
--
-- 1. A LEASE for the scheduled job. `runScheduled` had no mutual exclusion, and
--    two overlapping invocations are not merely wasteful:
--
--      * Cloudflare may retry a cron invocation, and `ctx.waitUntil` lets a slow
--        pass outlive its trigger, so two passes overlapping is expected, not
--        exotic.
--      * The rollup is DELETE-then-INSERT inside one `db.batch()` per day, which
--        is idempotent alone but not against a concurrent pass: two of them
--        interleaving at the day granularity can leave a day whose rollup rows
--        were deleted by one pass after the other had inserted them, i.e. a day
--        that reads as ZERO from the rollups.
--      * Worse, both passes reach step 3 and DELETE raw rows. That is the one
--        irreversible operation here, and a day whose rollup lost the race has
--        just had its raw rows removed.
--
--    One row, `id = 1`, taken with a conditional upsert and released on the way
--    out. See `acquireRollupLease` in src/rollup.ts.
--
-- 2. ON DELETE CASCADE from the rollup tables to `projects`. Rollups are kept
--    INDEFINITELY by design, and they carried `project_id` with no foreign key —
--    so deleting a project cascaded `keys` (0001 has that FK) and left every one
--    of that project's rollup rows in the database forever, unreachable but
--    retained. For a backend whose §13 promise is about what it does not keep,
--    "kept forever, with no way to read or delete it" is the wrong default.
--
--    SQLite cannot add a foreign key to an existing table, so each table is
--    rebuilt and renamed. The tables are small (one row per project/day/variant)
--    and this runs once.
--
--    Note what the FK now also asserts: a rollup row can only exist for a project
--    in `projects`. That cannot fail in practice — `keys.project_id` already
--    references `projects`, ingest derives `project_id` from the write key's
--    scope, and rollups are aggregated from `events` — so every path that can
--    write a rollup row went through a key belonging to a live project.

--------------------------------------------------------------------------------
-- 1. The scheduled job's lease.
--------------------------------------------------------------------------------

-- Single-row by construction: the CHECK makes `id = 1` the only insertable
-- value, so there is no way to end up with two leases and no way for a caller to
-- pick a key that misses the one that exists.
--
-- `holder` is an invocation-scoped random token, not anything about a client:
-- §13 forbids identifiers of the backend's own invention *about a person*, and
-- this one names a cron run. It exists so a release can verify it still holds the
-- lease it took rather than releasing someone else's.
CREATE TABLE rollup_lease (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder       TEXT NOT NULL,
  acquired_at  TEXT NOT NULL             -- ISO 8601 UTC ms, §0
) STRICT;

--------------------------------------------------------------------------------
-- 2. ON DELETE CASCADE on the three rollup tables.
--------------------------------------------------------------------------------

CREATE TABLE daily_rollups_v2 (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day             TEXT NOT NULL,
  include_debug   INTEGER NOT NULL,
  opens           INTEGER NOT NULL,
  sessions        INTEGER NOT NULL,
  active_installs INTEGER NOT NULL,
  events          INTEGER NOT NULL,
  rolled_at       TEXT NOT NULL,
  PRIMARY KEY (project_id, day, include_debug)
) STRICT;

INSERT INTO daily_rollups_v2
  (project_id, day, include_debug, opens, sessions, active_installs, events, rolled_at)
SELECT project_id, day, include_debug, opens, sessions, active_installs, events, rolled_at
  FROM daily_rollups;

DROP TABLE daily_rollups;

ALTER TABLE daily_rollups_v2 RENAME TO daily_rollups;

CREATE TABLE daily_event_rollups_v2 (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  include_debug  INTEGER NOT NULL,
  name           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  installs       INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, include_debug, name)
) STRICT;

INSERT INTO daily_event_rollups_v2
  (project_id, day, include_debug, name, count, installs)
SELECT project_id, day, include_debug, name, count, installs
  FROM daily_event_rollups;

DROP TABLE daily_event_rollups;

ALTER TABLE daily_event_rollups_v2 RENAME TO daily_event_rollups;

-- `value_key`, `value_type` and `is_null` keep the roles 0001 documents: NULLs
-- are DISTINCT in a SQLite unique index, so the nullable `value` cannot carry
-- uniqueness, and `value_type` is in the key because the JSON boolean `true` and
-- the JSON string "true" are different prop values that share a `value_key`.
CREATE TABLE daily_prop_rollups_v2 (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  include_debug  INTEGER NOT NULL,
  name           TEXT NOT NULL,
  prop           TEXT NOT NULL,
  value_type     TEXT NOT NULL CHECK (value_type IN ('text', 'true', 'false', 'null')),
  value_key      TEXT NOT NULL,
  is_null        INTEGER NOT NULL,
  value          TEXT,
  count          INTEGER NOT NULL,
  installs       INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, include_debug, name, prop, value_type, value_key, is_null)
) STRICT;

INSERT INTO daily_prop_rollups_v2
  (project_id, day, include_debug, name, prop, value_type, value_key, is_null, value, count, installs)
SELECT project_id, day, include_debug, name, prop, value_type, value_key, is_null, value, count, installs
  FROM daily_prop_rollups;

DROP TABLE daily_prop_rollups;

ALTER TABLE daily_prop_rollups_v2 RENAME TO daily_prop_rollups;
