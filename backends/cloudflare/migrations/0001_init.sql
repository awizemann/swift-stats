-- swift-stats Cloudflare/D1 backend — initial schema.
-- Contract: ../../docs/schema.md (wire schema v1). Where this file and that
-- document disagree, this file is wrong.
--
-- Design notes that are load-bearing:
--
--  * `events.day` is a DERIVED bucket column, not `substr(ts,1,10)`. Schema §10
--    requires tolerating a future-dated or implausibly old `ts` and SHOULD have
--    the backend clamp it into the retention window for aggregation. So `ts` is
--    stored verbatim (auditable) and `day` carries the clamped UTC calendar day
--    that every read groups by. A device with a wrong clock cannot create rows
--    outside the retention window, which is also what keeps the retention
--    delete total.
--
--  * `events.is_debug` is denormalized off the batch context so the
--    `includeDebug=false` default (§8.1) is an indexed predicate rather than a
--    join.
--
--  * `props` is a JSON text column, not a key/value side table. The §8.2
--    breakdown is served with `json_each` / `json_type`, which keeps ingest to
--    one row per event (D1 bills rows written) and keeps a 32-key event from
--    fanning out into 32 inserts.
--
--  * Distinct sessions are keyed on `(install_id, session_id)` per §10 — a
--    `sessionId` is NOT globally unique. Never `COUNT(DISTINCT session_id)`.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,          -- the `projectId` on the wire, §2.4
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL              -- ISO 8601 UTC ms, §0
) STRICT;

-- Keys are stored as SHA-256 hex ONLY. The plaintext is printed once at mint
-- time and never persisted, so a dump of this table cannot be replayed against
-- the ingest endpoint.
CREATE TABLE keys (
  key_hash    TEXT PRIMARY KEY,          -- lowercase hex SHA-256 of the key
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('write', 'read')),
  label       TEXT,                      -- operator note, e.g. "Overwatch macOS 1.4"
  created_at  TEXT NOT NULL,
  revoked_at  TEXT                       -- NULL = live; any value = rejected 401
) STRICT;

CREATE INDEX keys_by_project ON keys (project_id, kind);

-- Idempotency (§6). The PRIMARY KEY is the dedupe: the insert of the batch row
-- is the first statement of the same D1 batch as the event inserts, so a
-- duplicate `batchId` fails the whole batch atomically and we answer 202
-- without having written events twice. `batch_id` is stored UPPERCASE (§1).
-- The key is (project_id, batch_id), NOT batch_id alone. Dedupe is a per-tenant
-- concern: a `batchId` collision across two projects is astronomically unlikely
-- at 122 random bits, but with a global key it would make one project's real
-- batch return 202 having written nothing, and there is no upside to that
-- coupling between tenants.
CREATE TABLE batches (
  batch_id     TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  event_count  INTEGER NOT NULL,
  PRIMARY KEY (project_id, batch_id)
) STRICT;

CREATE INDEX batches_by_received ON batches (received_at);

-- One context row per batch (§3): sent once per batch, so stored once per batch.
-- `os_name` and `arch` are stored VERBATIM including unknown values (§3).
-- No foreign key to `batches`: that table is keyed on (project_id, batch_id), so
-- `batch_id` alone is not a key to reference. It would be the wrong lifecycle
-- anyway — the dedupe ledger is purged at 30 days while context follows its
-- events out to 90, and the retention job manages both explicitly.
-- Keyed (project_id, batch_id) for the same reason `batches` is: a `batchId`
-- shared across two tenants must not make one tenant's insert fail.
CREATE TABLE batch_context (
  batch_id       TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  sent_at        TEXT NOT NULL,
  sdk_version    TEXT NOT NULL,
  app_version    TEXT NOT NULL,
  app_build      TEXT NOT NULL,
  bundle_id      TEXT NOT NULL,
  os_name        TEXT NOT NULL,
  os_version     TEXT NOT NULL,
  device_model   TEXT NOT NULL,
  arch           TEXT NOT NULL,
  locale         TEXT NOT NULL,
  region         TEXT NOT NULL,
  screen_width   INTEGER NOT NULL,
  screen_height  INTEGER NOT NULL,
  screen_scale   REAL NOT NULL,
  is_debug       INTEGER NOT NULL,
  is_testflight  INTEGER NOT NULL,
  color_scheme   TEXT,
  PRIMARY KEY (project_id, batch_id)
) STRICT;

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  batch_id    TEXT NOT NULL,
  day         TEXT NOT NULL,             -- clamped UTC YYYY-MM-DD; all reads group by this
  ts          TEXT NOT NULL,             -- verbatim from the emitter, §0
  name        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  install_id  TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  user_id     TEXT,                      -- opaque, §2.5; never in the read contract
  props       TEXT,                      -- JSON object or NULL
  is_debug    INTEGER NOT NULL
) STRICT;

-- The summary query's access path: one project, a contiguous run of days.
CREATE INDEX events_scope ON events (project_id, day);
-- /v1/events/top with `name`, and the retention delete's name-wise work.
CREATE INDEX events_scope_name ON events (project_id, day, name);
-- Per-install deletion (the §13 erasure obligation) and per-install debugging.
CREATE INDEX events_install ON events (install_id);
-- Retention sweep: a single range scan over the oldest days across all projects.
CREATE INDEX events_day ON events (day);
-- Lets the nightly `batch_context` purge test "does this batch still have any
-- events?" as one index probe per candidate row, instead of a scan of `events`
-- per row. Without it that purge is O(context rows x events).
CREATE INDEX events_batch ON events (batch_id);

--------------------------------------------------------------------------------
-- Rollups. Kept INDEFINITELY; raw events are deleted at 90 days.
--
-- `include_debug` is 0 for "debug traffic excluded" and 1 for "all traffic".
-- Two rows per day rather than a subtractable pair, because distinct counts are
-- not subtractable: all-minus-nondebug is not the debug-only distinct count.
--------------------------------------------------------------------------------

CREATE TABLE daily_rollups (
  project_id      TEXT NOT NULL,
  day             TEXT NOT NULL,
  include_debug   INTEGER NOT NULL,
  opens           INTEGER NOT NULL,      -- count of `app_open`, §8.1
  sessions        INTEGER NOT NULL,      -- distinct (install_id, session_id)
  active_installs INTEGER NOT NULL,      -- distinct install_id
  events          INTEGER NOT NULL,
  rolled_at       TEXT NOT NULL,
  PRIMARY KEY (project_id, day, include_debug)
) STRICT;

CREATE TABLE daily_event_rollups (
  project_id     TEXT NOT NULL,
  day            TEXT NOT NULL,
  include_debug  INTEGER NOT NULL,
  name           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  installs       INTEGER NOT NULL,       -- distinct install_id, exact per DAY
  PRIMARY KEY (project_id, day, include_debug, name)
) STRICT;

-- Per-prop-value breakdown for §8.2 beyond raw retention.
--
-- `value_key` exists because SQLite treats NULLs as DISTINCT in a UNIQUE index,
-- so a nullable `value` inside a PRIMARY KEY would let duplicate null rows
-- accumulate and break the rollup's idempotent upsert. `value_key` is NOT NULL
-- (the empty string for the null row) and carries the uniqueness; `is_null`
-- says which row is the §8.2 "null" row (explicit JSON null AND absent, folded).
--
-- `value_type` is in the PRIMARY KEY, not just alongside it, because the JSON
-- boolean `true` and the JSON string `"true"` are different prop values that
-- §8.2 must report as different rows — and they share a `value_key`. Without the
-- type in the key they would collide and be summed together. It is also what
-- lets a read past raw retention re-emit a bool as a JSON bool rather than as
-- the string it was stored as.
CREATE TABLE daily_prop_rollups (
  project_id     TEXT NOT NULL,
  day            TEXT NOT NULL,
  include_debug  INTEGER NOT NULL,
  name           TEXT NOT NULL,
  prop           TEXT NOT NULL,
  value_type     TEXT NOT NULL CHECK (value_type IN ('text', 'true', 'false', 'null')),
  value_key      TEXT NOT NULL,
  is_null        INTEGER NOT NULL,
  value          TEXT,                   -- NULL exactly when is_null = 1
  count          INTEGER NOT NULL,
  installs       INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, include_debug, name, prop, value_type, value_key, is_null)
) STRICT;

-- Bookkeeping for the scheduled job, so an operator can see what ran and a
-- re-run is diagnosable.
CREATE TABLE rollup_state (
  day         TEXT PRIMARY KEY,
  rolled_at   TEXT NOT NULL,
  event_rows  INTEGER NOT NULL
) STRICT;
