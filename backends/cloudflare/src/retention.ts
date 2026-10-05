// Changing a project's raw-retention window (0006) — the one write path for it.
//
// A bare `UPDATE projects SET retention_days = …` is correct for a DECREASE and
// wrong for an INCREASE. Raising the window moves the clock cutoff back at once,
// over days the sweep already removed under the old window; their raw rows are
// gone and their rollups are the only copy. Unless something records where raw
// rows are actually complete, a late batch or a clamped wrong-clock event lands
// one raw row in such a day, reads replace the day's history with that row, and
// the sweep later rolls the row up over the real rollup. `raw_complete_from`
// (0007) is that record, and this statement is what keeps it in step with the
// window: both columns change in ONE UPDATE, computed from the row's own old
// value, so there is no moment at which the new window is live without its
// marker.
//
// `scripts/admin.mjs set-retention` runs the same SQL (it is dependency-free
// Node and cannot import this file); keep the two identical.

import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, today } from './dates.js';

/**
 * The statement, shared verbatim with `admin.mjs`. Binds: ?1 project id, ?2 new
 * window in days, ?3 today (UTC `YYYY-MM-DD`).
 *
 * On an increase the marker becomes the OLD clock cutoff — or the project's
 * oldest surviving raw day when that is older (an unswept day is complete) — and
 * never moves backwards past a marker an earlier increase set and the clock has
 * not yet passed (`max`). A decrease or no-op leaves the marker alone; the
 * sweep clears it once the cutoff passes it. The old window is clamped exactly as
 * `clampRetentionDays` clamps it, so a hand-edited row cannot put the marker
 * somewhere the Worker never treated as the boundary.
 */
export const SET_RETENTION_SQL = `UPDATE projects
   SET raw_complete_from = CASE
         WHEN ?2 > max(${MIN_RETENTION_DAYS}, min(${MAX_RETENTION_DAYS}, COALESCE(retention_days, ${MIN_RETENTION_DAYS})))
         THEN max(
                COALESCE(raw_complete_from, ''),
                min(
                  date(?3, '-' || (max(${MIN_RETENTION_DAYS}, min(${MAX_RETENTION_DAYS}, COALESCE(retention_days, ${MIN_RETENTION_DAYS}))) - 1) || ' days'),
                  COALESCE((SELECT MIN(day) FROM events WHERE project_id = projects.id), '9999-12-31')
                )
              )
         ELSE raw_complete_from
       END,
       retention_days = ?2
 WHERE id = ?1`;

/**
 * Set `projectId`'s raw-retention window to `days` (90–400), moving
 * `raw_complete_from` with it. Throws `RangeError` outside the bounds rather
 * than clamping — a caller asking for 30 is asking for something this backend
 * will not do, and silently storing 90 would look like it worked. Returns whether
 * a project row was updated.
 *
 * `projectId` must already be authorized; like everything under `src/lib`, this
 * does not authorize.
 */
export async function setProjectRetention(
  db: D1Database,
  projectId: string,
  days: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new RangeError(
      `retention must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`,
    );
  }
  const result = await db.prepare(SET_RETENTION_SQL).bind(projectId, days, today(now)).run();
  return (result.meta.changes ?? 0) > 0;
}
