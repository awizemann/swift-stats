-- swift-stats Cloudflare/D1 backend — migration 0005.
--
-- `installs`: one row per (project, install), carrying the first UTC day that
-- install was ever seen.
--
-- Why this table exists at all, given `events` already has `install_id`. Raw
-- events live 90 days by default (README §4) and are then deleted; the rollups
-- that outlive them store per-day DISTINCT COUNTS, and a distinct count cannot
-- answer "was this install new that day?". So the one fact that cannot survive
-- raw retention in any aggregate form is FIRST SIGHTING — and first sighting is
-- what retention cohorts, "new vs returning", and any honest growth number are
-- built out of. Without it, a project that has been running for a year can say
-- how many installs were active on a day 200 days ago and cannot say how many of
-- them were new, ever, at any point in the future.
--
-- It is deliberately the SMALLEST thing that answers that: a day, not a
-- timestamp; no session, no event name, no props, no context. One row per
-- install, ever — so it grows with installs, not with traffic, and a busy
-- install costs the same as a silent one.
--
-- On §13. This table keeps an `install_id` — the SDK's own salted-hash identifier
-- (§9), not one of this backend's invention — past the raw retention window, so
-- it has to be justified rather than assumed:
--
--   * It is EXEMPT from the raw purge by design (that is the point of it), which
--     means the retention promise has to be stated as it actually is: raw events,
--     with everything attached to them, go at the cutoff; a bare install id and a
--     day survive. The READMEs say so rather than leaving it to be discovered.
--   * The §13 erasure obligation still resolves completely: `delete-install`
--     deletes from `installs` as well as `events` (see scripts/admin.mjs), so an
--     erased install leaves nothing behind here either.
--   * ON DELETE CASCADE to `projects`, matching what 0002 did for the rollup
--     tables and for the same reason: "retained forever with no way to read or
--     delete it" is the wrong default for a backend whose §13 promise is about
--     what it does not keep.
--   * No reader can extract an id. The query helper exported for this
--     (`firstSeenRows` in src/lib/queries.ts) returns COUNTS PER DAY and there is
--     no code path in the read contract that returns an `install_id`.
--
-- Ingest writes it as ONE `INSERT OR IGNORE` per batch covering every distinct
-- install in that batch — not one statement per event — inside the same
-- `db.batch()` as the events, so it commits with them or not at all, and a
-- duplicate `batchId` (§6) cannot half-write it. `OR IGNORE` is what makes
-- `first_seen_day` immutable: the second sighting of an install is a no-op, so
-- the stored day is the first this backend ever saw, never the most recent.

CREATE TABLE installs (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  install_id      TEXT NOT NULL,            -- §9 install id, verbatim from the wire
  first_seen_day  TEXT NOT NULL,            -- clamped UTC YYYY-MM-DD, same bucket as events.day
  PRIMARY KEY (project_id, install_id)
) STRICT;

-- The access path for a cohort read: one project, a contiguous run of first-seen
-- days. Without it, `firstSeenRows` is a full scan of every install a project has
-- ever had in order to count the ones from one month.
CREATE INDEX installs_first_seen ON installs (project_id, first_seen_day);

-- Backfill from the raw events that are still here. `MIN(day)` per install is the
-- best available answer and is exactly right for any install whose first event is
-- still inside the raw window; for an older install it reads as the oldest
-- SURVIVING day, which is a documented over-estimate of newness (that install
-- looks like it arrived on the retention boundary) and the reason this table
-- should have existed from 0001. It only affects installs already present when
-- this migration ran; everything after is exact.
--
-- `OR IGNORE` so the statement is safe to re-run — the table is empty the first
-- time, and on a re-apply it must not fail and must not overwrite a first_seen_day
-- that ingest has since recorded correctly.
--
-- The GROUP BY is index-assisted since 0003: that migration's `events_identity`
-- UNIQUE index on (project_id, install_id, seq) has (project_id, install_id) as
-- its prefix, so SQLite can walk the index in grouping order instead of scanning
-- `events` and building a temporary b-tree to group it. That matters here because
-- this scan touches every surviving raw row on a deployment with real data — it
-- is why 0003 should be applied first, which the numbering already enforces.
INSERT OR IGNORE INTO installs (project_id, install_id, first_seen_day)
SELECT project_id, install_id, MIN(day)
  FROM events
 GROUP BY project_id, install_id;

-- The boundary that backfill left behind, so a reader can LABEL it.
--
-- The backfill above is honest but unmarked, and that is a real gap: for an
-- install whose first event has already aged out, `MIN(day)` is the oldest
-- SURVIVING day, so the install reads as having arrived on the retention
-- boundary. Nothing in the data says which rows those are, so a cohort chart
-- drawn across the migration date shows a spike at the boundary that a consumer
-- cannot distinguish from a real one — it would just be wrong, confidently.
--
-- One row is enough to fix that. Record the UTC day this migration ran; the
-- floor a reader must not trust below is then derivable per project from that
-- day and the project's own retention window (`firstSeenFloorDay` in
-- src/lib/queries.ts). Deliberately NOT a `first_seen_is_exact` column on
-- `installs`: that would be a per-row flag carrying one repository-wide fact,
-- and it would have to be written for every future row forever to stay true.
--
-- A generic key/value table rather than `installs_backfill_day` as its own
-- table, because the next such fact should not need another migration. It is
-- deliberately tiny and deliberately not a config store: nothing in the request
-- path reads it, and every value in it is a fact about the DEPLOYMENT's history,
-- not a setting anyone may change.
CREATE TABLE backend_markers (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

-- `date('now')` is the UTC day, matching the `YYYY-MM-DD` form every other day
-- in this schema takes. Written in the SAME migration as the backfill, so the
-- marker and the rows it describes cannot disagree.
--
-- `OR IGNORE` for the same reason the backfill has it: re-applying this file by
-- hand must not move a marker that already describes an earlier, real backfill.
--
-- A FRESH deployment runs this migration against an empty `events` table, so the
-- backfill inserts nothing and there is nothing to distrust. The marker is still
-- written — it names the day, and on a fresh database the floor it implies simply
-- sits below every install there will ever be. A deployment created BEFORE 0005
-- existed is the case the marker is for.
INSERT OR IGNORE INTO backend_markers (key, value)
VALUES ('installs_backfill_day', date('now'));
