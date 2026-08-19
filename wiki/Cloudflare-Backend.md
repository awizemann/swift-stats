---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: backends/cloudflare
source_paths_inferred: false
---

# Cloudflare Backend

The reference backend for swift-stats: a single Cloudflare Worker plus one D1
database that implements the whole of the `v1` wire schema — ingest, the two
read endpoints, and a nightly Cron Trigger that rolls up closed days and ages
out raw events.

It lives in `backends/cloudflare/`. Zero runtime dependencies, **one binding**
(D1), and **no Worker secrets**: API keys live hashed in D1, so there is no
`[vars]` block and nothing to rotate in the Worker itself.

For the wire contract these routes implement, see
[Wire Schema Reference](Wire-Schema-Reference). To stand a deployment up, see
[Deployment & Operations](Deployment-&-Operations).

## Stack

| Piece | What |
|---|---|
| Runtime | Cloudflare Workers (`compatibility_date = "2025-09-01"`), TypeScript, ES modules |
| Storage | D1 (SQLite), one database named `stats`, binding `DB` |
| Schema | `migrations/0001_init.sql`, `0002_rollup_lease_and_cascade.sql`, `0003_event_idempotency.sql` |
| Scheduled work | Cron Trigger `10 2 * * *` (02:10 UTC) |
| Tests | `vitest` + `@cloudflare/vitest-pool-workers` against a local D1 |
| Admin | `scripts/admin.mjs` (Node 20+, no dependencies, shells out to `wrangler`) |

Source layout worth knowing:

```
src/index.ts      router, HEAD handling, the scheduled entry point
src/ingest.ts     POST /v1/events
src/read.ts       HTTP layer for the two read endpoints (auth, params, envelope)
src/lib/queries.ts  the read contract itself — routing, counts, caps, ordering
src/rollup.ts     the cron: lease, rollups, retention sweep
src/keys.ts       hashing, key resolution, scope checks
src/ratelimit.ts  the per-isolate advisory limiter
src/validate.ts   envelope/event/context/props validation and the caps
src/dates.ts      UTC day arithmetic, `rawCutoffDay`, `bucketDay`
src/errors.ts     `HttpError` and the stable snake_case error codes
src/log.ts        structured logging with a closed field list
```

## Routes

| Method | Path | Auth header | Success |
|---|---|---|---|
| `POST` | `/v1/events` | `X-Stats-Key` (write key) | **202** with a small JSON body |
| `GET` / `HEAD` | `/v1/summary` | `X-Stats-Read-Key` (read key) | 200, per-day rows |
| `GET` / `HEAD` | `/v1/events/top` | `X-Stats-Read-Key` | 200, top event names |
| `GET` / `HEAD` | `/v1/events/top?name=…` | `X-Stats-Read-Key` | 200, the §8.2 prop breakdown for that one name |
| `GET` / `HEAD` | `/health` | none | `200 {"ok":true,"schema":"v1"}` |

`HEAD` is routed explicitly wherever `GET` is, because workerd does not
synthesize it — an uptime checker doing `HEAD /health` would otherwise get a
405. It is **not** accepted on `/v1/events`, which stays `POST`-only. Every
other method on a known path is **405** with an `Allow` header, and an unknown
path is **404** (`not_found`). 404 is for unknown *paths* only: an unknown
project or event name is never a 404.

`/health` reads no D1 and checks no key, so it cannot fail for a reason
unrelated to the Worker being up.

## The ingest pipeline

`handleIngest` in `src/ingest.ts`, in this exact order — the order is the design:

1. **`Content-Type`** must have media type `application/json` (parameters and
   case tolerated). Otherwise **400** `bad_content_type`.
2. **`Content-Encoding`**: absent, empty, or `identity` passes. Anything else
   (including `gzip`, which this backend does not support) is **400**
   `unsupported_encoding` rather than a silent mis-parse.
3. **Pre-auth rate limit**, keyed on the SHA-256 of the presented key — never on
   the IP. Runs *before* the key lookup so a key-guessing loop does not get a
   free D1 read per attempt.
4. **Key lookup.** `resolveKey` rejects a missing key or one shorter than 8 /
   longer than 256 characters without touching D1; otherwise it hashes the key
   (SHA-256, lowercase hex) and does an indexed lookup on
   `keys.key_hash` with `kind = 'write'` and `revoked_at IS NULL`. Any failure
   is a single, byte-identical **401** `unauthorized`.
5. **Post-auth project limit**, keyed on the resolved `projectId`, so minting
   more keys for one project does not multiply its share.
6. **Body read — only now.** An unauthenticated or obviously-wrong caller never
   gets the Worker to read 256 KiB. The read is a counting loop that aborts at a
   **2 MiB** wire cap (`Content-Length` is only ever trusted to reject early),
   then enforces the §5 **256 KiB** (`262144` bytes) uncompressed limit; both
   are **413** `payload_too_large`, the second with a "re-split the batch"
   message.
7. **Validation** (`src/validate.ts`): `schema` must be `v1`; 1–**100** events;
   names, ids, timestamps and context fields against their documented formats;
   integer bounds (`seq` ≤ 2^53−1, screen dimensions ≤ 1000000, screen scale ≤
   1000). Props violations **truncate and drop** rather than reject — at most
   **32** keys, keys matching `^[a-z][a-z0-9_]*$` and ≤ 40 scalars, string
   values truncated to **200** scalars — and every adjustment is counted for the
   `props_adjusted` log. An object/array props *value* is still a **400**.
8. **`projectId` derivation.** The value stored comes from the write key's
   scope. A client-asserted `projectId` that disagrees is **400**
   `project_mismatch`; a batch with none at all is fine.
9. **One `db.batch()`**, in this statement order:
   - the `batches` row **first** (plain `INSERT`),
   - the `batch_context` row,
   - one `INSERT … ON CONFLICT (project_id, install_id, seq) DO NOTHING` per event.
10. **202** is returned only after `db.batch()` resolves. Logging runs after the
    response under `ctx.waitUntil` (`deferLog`), so nothing sits between the
    commit and the acknowledgement.

### Idempotency, at two levels

**Batch level (§6).** `batches` has PRIMARY KEY `(project_id, batch_id)` and its
insert is the first statement of the same D1 batch, so a duplicate `batchId`
aborts the whole batch atomically — no read-then-write race, no double write.
The catch block then *asks the database* (`SELECT 1 FROM batches WHERE
project_id = ? AND batch_id = ?`) rather than matching a driver error string,
and answers **202** with `{"accepted": n, "duplicate": true}`. `batchId` is
uppercased before use. The ledger is kept 30 days.

**Event level (migration 0003).** `events` carries a UNIQUE index
`events_identity` on `(project_id, install_id, seq)`. A crash between the 202
and the emitter's queue marker replays the same events under a *fresh*
`batchId`, which batch-level dedupe cannot see; `ON CONFLICT … DO NOTHING`
swallows them. The Worker counts the statements D1 reports with
`meta.changes === 0` and logs `events_deduped` with counts only. The response is
unchanged — still 202, still `{"accepted": <events in the batch>}` — because §7's
202 is a durability statement, not a novelty statement.

`ON CONFLICT … DO NOTHING` and not `INSERT OR IGNORE`: naming the conflict
target keeps the suppression to the identity index, so a `NOT NULL` or STRICT
datatype failure still throws and still becomes an honest 400.

### Status → emitter behaviour

The status is the retry policy (§7), so each one is chosen for what the emitter
will do with it:

| Status | Code(s) | Cause | Emitter |
|---|---|---|---|
| **202** | — | committed, or a duplicate batch | delete from the queue |
| **400** | `bad_content_type`, `unsupported_encoding`, `bad_json`, `bad_schema_version`, `invalid_envelope`, `invalid_event`, `invalid_context`, `reserved_event_name`, `mixed_batch`, `project_mismatch`, `too_many_events`, `empty_events` | shape the database will never accept | **drop permanently** |
| **401** | `unauthorized` | missing, unknown, revoked, or wrong-kind key | drop |
| **413** | `payload_too_large` | body over 256 KiB / 2 MiB, or D1 refused for **size** (`string or blob too big`, `SQLITE_TOOBIG`, `too many SQL variables`) | re-split into new batches with new `batchId`s |
| **429** | `rate_limited` | limiter tripped; carries `Retry-After` | retain and wait |
| **503** | `internal_error` | anything unrecognized, including the duplicate-check `SELECT` itself failing; carries `Retry-After: 5` | retain and retry |
| **500** | `internal_error` | an unexpected throw anywhere else | retain and retry |

The load-bearing rule: an unrecognized D1 failure falls through to **503**, so a
D1 message-format change costs the improvement, never data. And a size failure
is never folded into the 400 branch — a batch D1 refused merely for being large
would otherwise be dropped when re-splitting would have stored it.

Error bodies are always `{"error": "<stable_snake_case>", "message": "…"}`, and
the request body is never echoed.

## Rate limiting

`src/ratelimit.ts`, window `RATE_WINDOW_MS = 60_000`:

| Bucket | Limit | Where |
|---|---|---|
| SHA-256 of the presented **write** key | `PRE_AUTH_LIMIT_PER_WINDOW = 600`/min | pre-auth, `/v1/events` |
| SHA-256 of the presented **read** key | `READ_LIMIT_PER_WINDOW = 120`/min | pre-auth, `/v1/summary`, `/v1/events/top` |
| `projectId` | `INGEST_LIMIT_PER_WINDOW = 600`/min | post-auth, `/v1/events` |
| `anonymous` (no key, or one of impossible length) | 600/min | pre-auth, every path |

Reads are six times tighter on purpose: a read key is one dashboard or script,
while a write key is a whole fleet — every install of an app presents the same
one.

**The caveat that matters:** these counters are a module-scope `Map` inside
**one isolate**. Cloudflare runs many isolates per colo and many colos and
recycles them at will, so the effective global ceiling is this number times an
unknown, time-varying multiple, and an eviction resets a window to zero. Nothing
may be built on these numbers being exact. The durable limit is a Cloudflare
Rate Limiting (WAF) rule in front of the Worker, keyed on the key header rather
than the IP; `backends/cloudflare/README.md` carries a ready ruleset, and
`ADOPTION.md` discusses the in-Worker global options and why none is
implemented here.

The bucket key is never the IP: §13 forbids storing or logging it, and a `Map`
keyed on `CF-Connecting-IP` is storage, just short-lived.

## Reads

Both endpoints take `projectId`, `from`, `to` (`YYYY-MM-DD`, UTC, inclusive) and
optional `includeDebug`; `/v1/events/top` also takes optional `name` and
`limit` (1–100, default 20 — `DEFAULT_LIMIT`/`MAX_LIMIT`).

- `includeDebug` defaults to **false**: debug-build traffic is out of the
  headline numbers unless asked for.
- A `to` after today (UTC) is clamped to today; the response echoes the range
  actually served. A span over `MAX_RANGE_DAYS = 400` is **400** `range_too_large`.
- `/v1/summary` zero-fills every day in the served range, ascending.
- `/v1/events/top?name=` breaks down at most `MAX_BREAKDOWN_PROPS = 20` props,
  applied once over the merged result so a range straddling the retention
  boundary returns the same props either side would.

**Check order is fixed and load-bearing:** key → scope → dates. A malformed or
out-of-scope `projectId` is a **401**, not a 400 — answering 400 there would let
an unauthenticated caller probe which projects exist. The 404-vs-401 rule
follows from the same thing: 404 is for an unknown path only, an out-of-scope
project is byte-identical to a nonexistent one, and an unknown event name is a
200 with empty `rows`.

Every computation lives in `src/lib/queries.ts` so a sibling Worker bound to the
same D1 can import the identical read contract instead of re-implementing it;
`src/read.ts` is HTTP only. A consumer still owns authorization and transport.

## The rollup cron

`src/rollup.ts`, triggered by `crons = ["10 2 * * *"]` — 02:10 UTC, comfortably
after midnight so "yesterday" is closed and off the busy top of the hour.

1. **Take the lease.** `acquireRollupLease` is one conditional upsert on the
   single-row `rollup_lease` table, atomic against a concurrent acquire;
   `LEASE_TTL_MS` is 30 minutes and the release verifies the holder token. Two
   overlapping passes are not merely wasteful — their delete-then-insert rollups
   can interleave and leave a day reading as zero whose raw rows the other pass
   then deletes.
2. **Roll the trailing window.** `REROLL_DAYS = 4` closed days, yesterday first,
   so a batch queued offline for a couple of days is absorbed without a dirty-day
   ledger. Each day is one `db.batch()` of delete-then-insert per
   `include_debug` variant, plus a `rollup_state` upsert.
3. **Roll every expiring day.** Every distinct `events.day` below the cutoff is
   rolled before anything is deleted. If any of them fails, the sweep is
   abandoned entirely.
4. **Sweep.** `DELETE FROM events WHERE day < rawCutoffDay(now)` —
   `RAW_RETENTION_DAYS = 90`, and the read layer uses the same `rawCutoffDay`
   definition so the delete and read boundaries cannot drift. `batch_context`
   rows follow their events (`NOT EXISTS`, no time predicate); the dedupe ledger
   has its own `DEDUPE_RETENTION_DAYS = 30` window.

Delete-then-insert rather than an upsert, because only that is self-correcting
after a per-install erasure. The whole job is idempotent: re-running a day
recomputes it, and if `rolled.length < REROLL_DAYS` the retention delete is
skipped rather than run on unaggregated days. Rollups are kept **indefinitely**;
raw events are not.

Prop rollups are capped at `MAX_ROLLED_VALUES_PER_PROP = 200` distinct values
per (project, event name, prop) per day; the null row is always kept.

## Data model

From the migrations, exactly:

| Table | Columns | Key / indexes |
|---|---|---|
| `projects` | `id`, `name`, `created_at` | PK `id` |
| `keys` | `key_hash`, `project_id`, `kind` (`write`\|`read`), `label`, `created_at`, `revoked_at` | PK `key_hash`; index `keys_by_project (project_id, kind)`; FK → `projects` ON DELETE CASCADE |
| `batches` | `batch_id`, `project_id`, `received_at`, `event_count` | PK `(project_id, batch_id)`; index `batches_by_received (received_at)` |
| `batch_context` | `batch_id`, `project_id`, `sent_at`, `sdk_version`, `app_version`, `app_build`, `bundle_id`, `os_name`, `os_version`, `device_model`, `arch`, `locale`, `region`, `screen_width`, `screen_height`, `screen_scale`, `is_debug`, `is_testflight`, `color_scheme` | PK `(project_id, batch_id)` |
| `events` | `id` (AUTOINCREMENT), `project_id`, `batch_id`, `day`, `ts`, `name`, `session_id`, `install_id`, `app_id`, `seq`, `user_id`, `props`, `is_debug` | PK `id`; indexes `events_scope (project_id, day)`, `events_scope_name (project_id, day, name)`, `events_install (install_id)`, `events_day (day)`, `events_batch (batch_id)`; UNIQUE `events_identity (project_id, install_id, seq)` |
| `daily_rollups` | `project_id`, `day`, `include_debug`, `opens`, `sessions`, `active_installs`, `events`, `rolled_at` | PK `(project_id, day, include_debug)`; FK → `projects` CASCADE |
| `daily_event_rollups` | `project_id`, `day`, `include_debug`, `name`, `count`, `installs` | PK `(…, name)`; FK → `projects` CASCADE |
| `daily_prop_rollups` | `project_id`, `day`, `include_debug`, `name`, `prop`, `value_type`, `value_key`, `is_null`, `value`, `count`, `installs` | PK `(…, name, prop, value_type, value_key, is_null)`; FK → `projects` CASCADE |
| `rollup_state` | `day`, `rolled_at`, `event_rows` | PK `day` |
| `rollup_lease` | `id` (CHECK `id = 1`), `holder`, `acquired_at` | PK `id` |

Every table is `STRICT`. Three decisions to know before changing anything:

- **`events.day` is a derived, clamped bucket**, not `substr(ts,1,10)`. `ts` is
  stored verbatim; `bucketDay` clamps a future-dated or implausibly old `ts`
  into the retention window, so a device with a wrong clock can neither create
  rows the sweep would never reach nor land counts in a future row.
- **`props` is a JSON text column**, read with `json_each` / `json_type`, so
  ingest stays at one row per event.
- **`include_debug` is two stored rollup rows per day**, not one subtractable
  pair: distinct counts do not subtract.
- Sessions are distinct `(install_id, session_id)`, never `session_id` alone.

## Keys

A key is 32 random bytes rendered as `sk_stats_<base64url>` (write) or
`rk_stats_<base64url>` (read). **Only the SHA-256 hex is stored.** The plaintext
is printed once, at mint time, and never written anywhere — there is no recovery
path by design; lose a key, revoke it and mint another.

```sh
node scripts/admin.mjs create-project <id> "<name>" --remote
node scripts/admin.mjs mint-key <projectId> write|read [--label "text"] --remote
node scripts/admin.mjs list-keys <projectId> --remote     # hashes, never keys
node scripts/admin.mjs revoke-key <64-hex key_hash> --remote
```

`mint-key` refuses a project that does not exist, so a transposed id cannot
print a convincing key that 401s forever. Revocation is an `UPDATE` setting
`revoked_at`, not a `DELETE`, so `keys` stays an audit trail. Rotation is
mint-then-revoke with both live in between, and involves no deploy — keys live
in D1, not in Worker secrets.

There is no constant-time comparison and none is needed: the presented key is
hashed and looked up by index, so no stored secret is ever compared.

A write key grants no reads — `kind` is part of the SQL lookup, so a write key
on a read endpoint gets the same 401 as an unknown one.

## Conformance suite

```sh
npm test        # vitest run
npm run typecheck
```

The suite runs against a local D1 inside `workerd` with **the real migration
files**, so no account, login, or network is needed. Four files:

| File | Covers |
|---|---|
| `test/ingest.test.ts` | the happy path, forward compatibility, §6 batch dedupe, per-event idempotency (0003), auth, `projectId` derivation, the 400 catalogue, 413 and the 2 MiB wire cap, props truncation, things a backend must *not* reject, routing and HEAD, integer bounds, rate limiting, `waitUntil` side effects, the storage-failure → status mapping, and the largest batch §5 permits |
| `test/read.test.ts` | read authentication, `/v1/summary`, `/v1/events/top` with and without `name` |
| `test/queries.test.ts` | `src/lib/queries.ts` directly — the module boundary, date validation and clamping, parameter parsing, raw/rollup routing, the observed boundary day, byte ordering |
| `test/rollup.test.ts` | the rollup, retention, reads past raw retention, the lease, the 00:00–02:10 read window, and the §8.2 prop cap across sources |

See [Contributing & Testing](Contributing-&-Testing) for how to run and extend
these.

## Further reading

- `backends/cloudflare/README.md` — the operator-facing reference: retention,
  cost shapes, the WAF ruleset, and §11 on reusing the query layer.
- `backends/cloudflare/ADOPTION.md` — the hardening pass written for a team
  running a managed SaaS fork: what changed, why, which test proves it, and the
  "recommended, not implemented" list (a genuinely global rate limit, per-tenant
  quotas, alerting on the scheduled job).
- `docs/SAAS-HANDOFF.md` — the 0.2.0 handoff brief.
- [Architecture](Architecture) for how this sits behind the SDK, and
  [Deployment & Operations](Deployment-&-Operations) for running it.

_Last updated: 2026-08-19 — rewritten from backends/cloudflare sources_
