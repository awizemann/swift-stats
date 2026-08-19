-- swift-stats Cloudflare/D1 backend — migration 0003.
--
-- PER-EVENT IDEMPOTENCY: a UNIQUE index on `events (project_id, install_id, seq)`.
--
-- Why, on top of the (project_id, batch_id) dedupe 0001 already has:
--
--   The emitter 202s a batch and only then writes its local queue marker. A
--   crash in that window replays the SAME EVENTS under a FRESH `batchId` — the
--   marker never landed, so the queue still holds them, and §6 requires a
--   re-split/reconstructed batch to get a new id. Batch-level dedupe cannot
--   see that: two different `batchId`s, same events, and the rollups
--   double-count opens, events and per-prop counts forever (rollups are kept
--   indefinitely, raw rows are not).
--
--   §2.2 makes (install_id, seq) an identity: `seq` is a counter starting at 0
--   for a fresh install, scoped to `install_id`, strictly increasing in the
--   order events were tracked and never reset within an install. So
--   (project_id, install_id, seq) names exactly one event, and a second row
--   with that triple is a replay, not a second event.
--
--   The reinstall objection ("`seq` restarts at 0") does not reach this key:
--   a reinstall — and a consent revoke/re-grant, §11 — starts a NEW install
--   UUID, so the restarted `seq` sits under a different `install_id`. Same for
--   denied `identity` consent (§11), where the emitter uses a fresh per-session
--   ephemeral install id: every session is its own `install_id` and its `seq`
--   is monotonic within it, so nothing across sessions can collide. The key is
--   scoped to `project_id` for the same reason `batches` is: one tenant's
--   events must never be able to suppress another's.
--
-- PRE-EXISTING DUPLICATES. A deployment that ran 0001/0002 may already hold
-- replayed rows, and `CREATE UNIQUE INDEX` over them fails — which in D1 fails
-- the migration, which runs once. So the duplicates are collapsed FIRST, in the
-- same file: for each (project_id, install_id, seq) the row with the smallest
-- `id` (the first delivery — `id` is AUTOINCREMENT, so it is insertion order)
-- is kept and every later row is deleted. That is the same row the index would
-- have kept had it existed at ingest time.
--
-- Both statements are idempotent on their own: the DELETE is a no-op once there
-- are no duplicates, and the index is created IF NOT EXISTS. Nothing here is
-- destructive beyond the replays it is defined to remove.
--
-- OPERATIONAL NOTE. This repairs the raw `events` table only. `daily_rollups`,
-- `daily_event_rollups` and `daily_prop_rollups` computed BEFORE this migration
-- may already have counted the duplicates, and rollups are kept indefinitely
-- while raw events are not. See ADOPTION.md §"Per-event idempotency" for the
-- re-roll procedure and for when a re-roll is no longer possible.

DELETE FROM events
 WHERE id NOT IN (
   SELECT MIN(id) FROM events GROUP BY project_id, install_id, seq
 );

CREATE UNIQUE INDEX IF NOT EXISTS events_identity
    ON events (project_id, install_id, seq);
