-- swift-stats Cloudflare/D1 backend — migration 0008.
--
-- ON DELETE CASCADE from the RAW tables — `events`, `batches`, `batch_context` —
-- to `projects`. 0002 did this for the rollup tables and 0005 created `installs`
-- with it; the three tables 0001 created for ingest were left with a bare
-- `project_id` and no foreign key at all. Three consequences, all observed:
--
--   * Deleting a project removed its keys, rollups and installs and left every one
--     of its raw events, dedupe rows and context rows behind — unreachable by any
--     read, and (since the sweep iterated `projects`) never aged out either. For a
--     backend whose §13 promise is about what it does not keep, that is the wrong
--     default, and the docs said a project delete cascaded.
--   * The nightly rollup used to roll a day across every project in `events`, and
--     the rollup tables DO reference `projects` (0002). One orphaned raw row made
--     that day's INSERT fail its foreign key, failing the whole day's batch — and
--     a short day count skipped the retention sweep for EVERY project, every night,
--     until someone noticed. (src/rollup.ts now rolls per project from
--     `projects`, so this cannot recur even on a database this has not run on.)
--   * 0005's `INSERT OR IGNORE INTO installs … FROM events` fails outright on an
--     orphaned event: `OR IGNORE` does not cover a foreign-key failure. See 0005.
--
-- SQLite cannot add a foreign key to an existing table, so each table is rebuilt
-- and renamed, the same way 0002 rebuilt the rollup tables. Every column, type,
-- constraint, STRICT, the AUTOINCREMENT `id` (copied verbatim — 0003 relies on
-- `id` being insertion order) and every index is carried over unchanged; only the
-- `REFERENCES projects(id) ON DELETE CASCADE` clause is new.
--
-- ORPHANS ARE DROPPED, NOT COPIED. A row whose project no longer exists cannot be
-- inserted into a table with this foreign key (D1 enforces foreign keys), and
-- there is nothing to keep it for: no read can reach it, it was only ever waiting
-- for a sweep that would not come. The `WHERE project_id IN (SELECT id FROM
-- projects)` on each copy is what heals a database that already has them.
--
-- Nothing references these three tables, so dropping them cannot cascade into
-- anything and needs no `PRAGMA defer_foreign_keys`. Dropping a table drops its
-- indexes, which is why each index is re-created by its original name after the
-- rename. `ALTER TABLE … RENAME` carries the AUTOINCREMENT counter in
-- `sqlite_sequence` with the table.
--
-- COST, for an operator about to apply this to a real deployment: it rewrites
-- every surviving raw row once (90 days by default, up to 400 per project), and
-- rebuilds seven indexes. D1 runs a migration file as one transaction; check the
-- row count of `events` first, exactly as ADOPTION.md §8.1 suggests for 0005.
--
-- A PROJECT DELETE IS NOW ONE STATEMENT OVER EVERYTHING THE PROJECT OWNS. For a
-- large project that cascade can itself be too big for one D1 statement; the
-- README describes deleting its `events` by day first in that case.

--------------------------------------------------------------------------------
-- batches — the §6 dedupe ledger (0001).
--------------------------------------------------------------------------------

CREATE TABLE batches_v2 (
  batch_id     TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  received_at  TEXT NOT NULL,
  event_count  INTEGER NOT NULL,
  PRIMARY KEY (project_id, batch_id)
) STRICT;

INSERT INTO batches_v2 (batch_id, project_id, received_at, event_count)
SELECT batch_id, project_id, received_at, event_count
  FROM batches
 WHERE project_id IN (SELECT id FROM projects);

DROP TABLE batches;

ALTER TABLE batches_v2 RENAME TO batches;

CREATE INDEX batches_by_received ON batches (received_at);

--------------------------------------------------------------------------------
-- batch_context — one row per batch (0001). Still no FK to `batches`, for the
-- lifecycle reason 0001 gives: the ledger is purged at 30 days, context follows
-- its events.
--------------------------------------------------------------------------------

CREATE TABLE batch_context_v2 (
  batch_id       TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

INSERT INTO batch_context_v2 (
  batch_id, project_id, sent_at, sdk_version, app_version, app_build, bundle_id,
  os_name, os_version, device_model, arch, locale, region,
  screen_width, screen_height, screen_scale, is_debug, is_testflight, color_scheme
)
SELECT batch_id, project_id, sent_at, sdk_version, app_version, app_build, bundle_id,
       os_name, os_version, device_model, arch, locale, region,
       screen_width, screen_height, screen_scale, is_debug, is_testflight, color_scheme
  FROM batch_context
 WHERE project_id IN (SELECT id FROM projects);

DROP TABLE batch_context;

ALTER TABLE batch_context_v2 RENAME TO batch_context;

--------------------------------------------------------------------------------
-- events (0001, plus 0003's identity index).
--------------------------------------------------------------------------------

CREATE TABLE events_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

INSERT INTO events_v2 (
  id, project_id, batch_id, day, ts, name, session_id, install_id, app_id, seq, user_id, props, is_debug
)
SELECT id, project_id, batch_id, day, ts, name, session_id, install_id, app_id, seq, user_id, props, is_debug
  FROM events
 WHERE project_id IN (SELECT id FROM projects);

-- Carry the AUTOINCREMENT high-water mark across, not just the surviving rows.
-- The copy above sets `events_v2`'s counter to the largest id it COPIED; if the
-- newest rows were orphans (or already swept), that is lower than ids the old
-- table handed out, and AUTOINCREMENT's whole promise — an id is never reused —
-- would quietly lapse. The old counter is at least every id ever issued.
DELETE FROM sqlite_sequence WHERE name = 'events_v2';

INSERT INTO sqlite_sequence (name, seq)
SELECT 'events_v2', seq FROM sqlite_sequence WHERE name = 'events';

DROP TABLE events;

ALTER TABLE events_v2 RENAME TO events;

-- The same six indexes, by the same names, with the same roles 0001/0003 give
-- them. `events_scope` (project_id first) is also what makes the cascade from a
-- project delete an index range rather than a scan.
CREATE INDEX events_scope ON events (project_id, day);
CREATE INDEX events_scope_name ON events (project_id, day, name);
CREATE INDEX events_install ON events (install_id);
CREATE INDEX events_day ON events (day);
CREATE INDEX events_batch ON events (batch_id);
CREATE UNIQUE INDEX events_identity ON events (project_id, install_id, seq);
