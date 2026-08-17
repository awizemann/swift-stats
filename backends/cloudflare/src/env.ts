/**
 * The Worker's bindings.
 *
 * There is exactly one, and no secret. Keys live *hashed* in D1 (§ README
 * "Keys"), so there is no `[vars]` block to leak and nothing to rotate here —
 * rotating a key is an INSERT plus an UPDATE on `keys`, not a redeploy.
 */
export interface Env {
  readonly DB: D1Database;
}
