/**
 * The Worker's bindings.
 *
 * There is exactly one binding, and no secret. Keys live *hashed* in D1 (§ README
 * "Keys"), so there is nothing secret to leak and nothing to rotate here —
 * rotating a key is an INSERT plus an UPDATE on `keys`, not a redeploy. The one
 * optional `[vars]` entry is a tuning number, not a credential.
 */
export interface Env {
  readonly DB: D1Database;
  /**
   * Optional `[vars]` entry: the per-invocation D1 query budget for the nightly
   * job (src/rollup.ts, `DEFAULT_QUERY_BUDGET`). Not a secret. Unset on the free
   * plan; raise it on Workers Paid, whose per-invocation query limit is higher.
   */
  readonly ROLLUP_QUERY_BUDGET?: string;
}
