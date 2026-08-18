# Cloudflare backend — Worker + D1

A small Worker that serves the whole of [`docs/schema.md`](../../docs/schema.md)
`v1`: ingest on `POST /v1/events`, reads on `GET /v1/summary` and
`GET /v1/events/top`, and a nightly Cron Trigger that rolls up closed days and
ages out raw events.

Zero dependencies at runtime, one binding (D1), no Worker secrets.

```
POST /v1/events        X-Stats-Key       (write key)  -> 202
GET  /v1/summary       X-Stats-Read-Key  (read key)
GET  /v1/events/top    X-Stats-Read-Key  (read key)
GET  /health           (none)
cron 10 2 * * *        roll up closed days, then delete raw events past 90 days
```

---

## 1. What it stores and where

**D1** (SQLite), one database named `stats`, schema in
[`migrations/0001_init.sql`](migrations/0001_init.sql).

| Table | Holds | Key / index |
|---|---|---|
| `projects` | tenants | `id` (the wire `projectId`) |
| `keys` | **SHA-256 hashes** of write and read keys | `key_hash`; `(project_id, kind)` |
| `batches` | the `batchId` dedupe ledger (§6) | `(project_id, batch_id)` PK — the dedupe *is* the PK |
| `batch_context` | the §3 context, once per batch | `batch_id` |
| `events` | one row per event | `(project_id, day)`, `(project_id, day, name)`, `(install_id)`, `(day)` |
| `daily_rollups` | per-day `opens` / `sessions` / `activeInstalls` / `events` | `(project_id, day, include_debug)` |
| `daily_event_rollups` | per-day per-event-name `count` / `installs` | `… , name` |
| `daily_prop_rollups` | per-day per-prop-value `count` / `installs` | `… , name, prop, value_type, value_key, is_null` |
| `rollup_state` | what the nightly job rolled, when | `day` |

Three decisions worth knowing before you change anything:

- **`events.day` is a derived, clamped bucket — not `substr(ts, 1, 10)`.** `ts` is
  stored verbatim, but §10 requires tolerating a future-dated or implausibly old
  `ts`, so `day` is clamped into the retention window. Every read groups by
  `day`. This is what stops a device with a wrong clock from creating rows the
  retention sweep would never reach, or landing counts in a future row that §8.1
  promises never appears.
- **`props` is a JSON column, not a key/value side table.** The §8.2 breakdown is
  served with `json_each` / `json_type`. Ingest stays at one row per event, which
  matters because D1 bills rows written and a 32-prop event would otherwise fan
  out into 33 inserts.
- **`include_debug` is stored as two rollup rows per day, not one subtractable
  pair.** Distinct counts do not subtract: all-installs minus non-debug-installs
  is not the count of debug-only installs.

Reads pick exactly one source per day — raw rows inside retention, rollups
outside — so a day is never double-counted and a late-arriving offline batch is
visible immediately rather than at the next rollup.

## 2. Deploy from zero

Requires a Cloudflare account and `npx wrangler login`.

```sh
cd backends/cloudflare
npm install

# 1. Create the database, then paste the printed id into wrangler.toml.
npx wrangler d1 create stats

# 2. Schema + Worker, in one command (this is `npm run deploy`).
npm run deploy

# 3. Create a project and mint its keys (see §7 below).
node scripts/admin.mjs create-project overwatch "Overwatch" --remote
node scripts/admin.mjs mint-key overwatch write --label "macOS 1.4" --remote
node scripts/admin.mjs mint-key overwatch read  --label "Overwatch app" --remote
```

`npm run deploy` runs `wrangler d1 migrations apply stats --remote` and then
`wrangler deploy`, in that order, so the schema is never behind the code.

## 3. Running it locally

```sh
npm install
npm run migrate:local     # apply migrations to the local D1
npm run dev               # wrangler dev --local, on http://localhost:8787
npm test                  # the conformance suite (vitest + workers pool + local D1)
npm run typecheck
```

The suite needs no account, no login, and no network — it runs against a local
D1 inside `workerd`, and it applies the **real** migration files rather than a
test-only schema.

To seed a local project and keys:

```sh
node scripts/admin.mjs create-project overwatch "Overwatch" --local
node scripts/admin.mjs mint-key overwatch write --local
node scripts/admin.mjs mint-key overwatch read --local
```

Then point the SDK at `http://localhost:8787` — §7 allows plain `http` for
loopback only, and `CloudflareEndpoint` enforces exactly that.

## 4. Retention

- **Raw events: 90 days.** Enforced, not asserted: the nightly job deletes
  `events` rows whose bucket day is older than the cutoff. The read layer uses
  the same `rawCutoffDay()` definition, so the delete boundary and the read
  boundary cannot drift apart.
- **Daily rollups: kept indefinitely.** `/v1/summary` keeps answering ranges far
  older than 90 days while nothing person-scale survives.
- **Order is not negotiable:** roll up first, delete second, and the delete is
  **skipped entirely** if any day in the re-roll window failed to roll. Deleting
  raw rows for a day that was never aggregated is the one irreversible operation
  in this backend.
- The job re-rolls the last **4** closed days each pass, so a batch queued
  offline for a couple of days (§1 permits this) is absorbed without a separate
  dirty-day ledger.
- `batch_context` rows are deleted with their events. The dedupe ledger
  (`batches`) has its own 30-day window.

Consequence to keep in mind: once a day's raw events are gone, **no new
dimension can be back-computed for it**. The rollup shape is part of the schema
design, not an afterthought.

## 5. `batchId` dedupe

**Window: 30 days. Mechanism: a D1 primary key, transactional with the insert.**

§6 requires at least 24 hours; 30 days is a wide margin and `batches` is one
narrow row per batch, so keeping it is cheap.

The `INSERT INTO batches` is the *first* statement of the same `db.batch()` as
the event inserts, so a duplicate `batchId` aborts the whole batch atomically —
events cannot be written twice, and there is no read-then-write race. (A
pre-flight `SELECT` would have exactly that race: two concurrent retries would
both see "absent".) A duplicate returns **202**, exactly as a first delivery
does, because §6 makes a duplicate a success, not an error.

`batchId` is uppercased before use, so a lowercase-emitting client's retry
deduplicates against its own first delivery.

## 6. Exact or approximate counts

**Exact**, with one documented exception.

- `/v1/summary` — `sessions` and `activeInstalls` are **exact**, always. They are
  `COUNT(DISTINCT …)` over raw rows inside retention, and per-day stored counts
  outside it. Rows are per-day, which is the granularity the rollups store, so
  nothing is estimated.
- `/v1/events/top` — `installs` is **exact** for any range lying wholly inside
  raw retention (90 days), which is the overwhelmingly common case. For a range
  reaching further back it is answered from per-day rollups, and because distinct
  counts are not additive across days, the number becomes an **upper bound**: an
  install active on five of those days contributes five. `count` is exact at any
  range.

No HyperLogLog, no sampling. A reader may present these as exact except for the
one case above, which it should describe as "at most".

Sessions are keyed on `(installId, sessionId)` per §10, never on `sessionId`
alone — session ids are not globally unique by construction.

## 7. Keys

`projectId` is derived from the write key's scope (§2.4) and stored from there;
a client-supplied `projectId` that disagrees is a **400**, never a silent
correction. Read keys are minted and scoped separately.

**Only SHA-256 hashes are stored.** The plaintext is printed once, at mint time,
and never written anywhere. A dump of the `keys` table cannot be replayed against
the endpoint. There is no recovery path by design — lose a key, revoke it and
mint another.

```sh
node scripts/admin.mjs mint-key <projectId> write|read [--label "…"] --remote
node scripts/admin.mjs list-keys <projectId> --remote     # shows hashes, never keys
node scripts/admin.mjs revoke-key <key-hash> --remote
```

**Rotation** is mint-then-revoke, with both live in between: mint the new key,
ship it, then revoke the old one. Revocation is an `UPDATE` setting `revoked_at`,
not a `DELETE`, so `keys` stays an audit trail of everything ever minted. There is
no deploy involved — keys live in D1, not in Worker secrets, so nothing here has
to be redeployed to rotate.

On **constant-time comparison**: there is none, and none is needed. We do not
compare a stored secret against a presented one; we hash the presented key and do
an indexed equality lookup on the hash. A timing signal from that lookup leaks at
most something about the hash, and inverting SHA-256 is the thing SHA-256 is for.
What *would* need a constant-time compare is storing keys in plaintext and using
`===`; that design is the reason this one exists.

A write key grants **no** reads: `kind` is part of the lookup, so a write key on a
read endpoint gets the same 401 as an unknown key.

## 8. `Content-Encoding: gzip`

**Not supported.** A gzipped body is rejected with **400** / `unsupported_encoding`
rather than silently mis-parsed, which is what §7 requires of a backend that does
not support it. Emitters default to uncompressed, so this only bites an emitter
explicitly configured against this README.

The Worker still caps the bytes it will read at **2 MiB** before the 256 KiB
uncompressed check, because `Content-Length` is a claim by the client and a
chunked request has none.

## 9. Props limit violations

**Truncate and drop** — this backend does not reject on a props *size* violation.

- A string value over 200 scalars is truncated to 200.
- Keys past the 32nd are dropped; the 32 kept are the first 32 in the byte-wise
  ascending key order of §0, so the emitter and this backend keep the **same** 32.
- A key that does not match `^[a-z][a-z0-9_]*$`, or is over 40 scalars, is dropped.
- Every adjustment is logged (counts only — never a key or a value).

§2.3 says a conforming backend SHOULD do this, so that an emitter bug degrades a
property rather than losing a day of data.

A props value of a **disallowed type** (object or array) is a different matter and
is always **400**, with no coercion, because coercing would silently invent a
value.

**Breakdown caps** (§8.2 permits these and requires they be documented):

- `/v1/events/top?name=` breaks down at most **20** props per event name — the
  most frequent in the range, `prop` ascending as a tiebreak.
- The rollup stores at most **200** distinct values per (project, event name,
  prop) per day. The null row is always kept regardless of the cap. Rollups live
  forever, so unbounded value cardinality would be an unbounded bill forever.
- Numeric props are omitted from breakdowns entirely, per §8.2.
- The cap is applied once over the **merged** result, so a range straddling the
  90-day boundary returns the same 20 props a range on either side alone would.

**Integer bounds** (§0 and §3 say "integer" without a range; this backend states
its own, because SQLite's `STRICT INTEGER` is int64 and the alternative is worse):

| Field | Accepted | Otherwise |
|---|---|---|
| `seq` | `0 … 2^53 - 1` | **400** |
| `context.screenWidth`, `context.screenHeight` | `0 … 1000000` | **400** |
| `context.screenScale` | `0 … 1000` | **400** |

`2^53 - 1` is the largest integer a JSON number represents exactly, so above it
two distinct `seq` values on the wire parse to the same number and there is
nothing to preserve. Zero is legal throughout: §3's consent-reduced fallback for
screen is `0`/`0`/`1.0`.

These are **400s, not 5xx**, and the distinction is the whole point. §7 makes a
5xx retain-and-retry, so a value the database will never accept reported as a
server fault becomes an infinite retry loop — the emitter re-sends the identical
bytes on a backoff until the 24-hour ceiling drops them, hitting this backend
every time. A data error is permanent, and saying so is the honest answer.

## 10. Operational notes

### Deleting one install

The §13 per-person erasure obligation:

```sh
node scripts/admin.mjs delete-install <64-hex installId> --remote
```

Raw rows go immediately. Rollups for days inside the nightly re-roll window
self-correct on the next pass, because the job is delete-then-insert rather than
an upsert. For an **older** day the rollup still includes that install's
contribution as a number; re-roll that specific day if it matters, and note that
once the day's raw rows are past retention there is nothing left to re-roll from.

### Rate limiting

Two layers, and only one of them is real.

**In the Worker (backstop).** `src/ratelimit.ts` counts requests per minute in a
per-isolate `Map` and throws a 429 with `Retry-After` past the limit:

| Bucket | Limit | Where |
|---|---|---|
| SHA-256 of the presented key | 600/min | **pre-auth**, on `/v1/events`, `/v1/summary`, `/v1/events/top` |
| `projectId` | 600/min | post-auth, on `/v1/events` |
| `anonymous` (no key, or one of impossible length) | 600/min | pre-auth, all three |

Two properties, both load-bearing:

- **The bucket key is never the IP.** §13 forbids storing or logging the client
  IP or anything derived from it, and a `Map` keyed on `CF-Connecting-IP` is
  storage — just short-lived. The SHA-256 of the presented key is available
  before authentication, is already what `keys.key_hash` holds, and is
  per-client in the way that matters.
- **It runs before `resolveKey`.** `resolveKey` costs a D1 read, so limiting
  after it would hand a key-guessing loop one free storage read per attempt.

It is deliberately *not* the real limit: an isolate is not a global counter, so a
client spread across isolates sees a multiple of these numbers.

**In front of the Worker (the durable limit).** A Cloudflare Rate Limiting rule,
global and counted at the edge. Create it once per zone —
**Security → WAF → Rate limiting rules → Create rule** — or with the API:

```jsonc
// PUT /client/v4/zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint
{
  "rules": [
    {
      "description": "swift-stats ingest, per write key",
      "expression": "(http.request.uri.path eq \"/v1/events\")",
      "action": "block",
      "action_parameters": {
        "response": {
          "status_code": 429,
          "content_type": "application/json",
          "content": "{\"error\":\"rate_limited\",\"message\":\"Too many requests.\"}"
        }
      },
      "ratelimit": {
        // Per write key, NOT per IP: many installs share an IP behind a carrier
        // NAT, and §13 keeps this backend out of the IP business anyway.
        "characteristics": ["cf.colo.id", "http.request.headers[\"x-stats-key\"]"],
        "period": 60,
        "requests_per_period": 600,
        "mitigation_timeout": 60
      }
    },
    {
      "description": "swift-stats reads, per read key",
      "expression": "(http.request.uri.path in {\"/v1/summary\" \"/v1/events/top\"})",
      "action": "block",
      "action_parameters": {
        "response": {
          "status_code": 429,
          "content_type": "application/json",
          "content": "{\"error\":\"rate_limited\",\"message\":\"Too many requests.\"}"
        }
      },
      "ratelimit": {
        "characteristics": ["cf.colo.id", "http.request.headers[\"x-stats-read-key\"]"],
        "period": 60,
        "requests_per_period": 120,
        "mitigation_timeout": 60
      }
    }
  ]
}
```

Keep the response body in the §8.3 shape (`{"error": …, "message": …}`) and the
status at 429, so an emitter's `IngestDisposition` table and a reader both see
the documented contract rather than Cloudflare's default block page.
Header-keyed characteristics need a paid Cloudflare plan; on the free plan the
rule falls back to IP keying, which is worse — but it stays outside the Worker
either way, so nothing in this backend stores or sees it.

A well-behaved emitter following §7 (at most one request in flight, exponential
backoff) never comes close to any of these.

### Cost

D1 bills rows read and rows written. The shapes that matter:

- **Ingest**: 2 + *n* rows written per batch (the batch row, the context row, one
  per event). Context is stored per batch, not per event, which is the difference
  between 2+*n* and 3*n* for a typical batch.
- **Summary**: an index range scan on `(project_id, day)` — rows read is
  proportional to the events in the range, not to the table. This is the query to
  watch: a busy project asking for 400 days reads 400 days of events. If that ever
  hurts, serve `/v1/summary` from `daily_rollups` for *all* closed days rather
  than only for days past retention; the rollups are already written and the read
  layer already knows how to stitch two sources.
- **`/v1/events/top?name=`**: three queries over `(project_id, day, name)`, plus
  a `json_each` expansion of the matching rows' props.
- **Nightly job**: a full pass over the previous 4 days plus one ranged delete.

### Logging

Nothing person-scale is ever logged: no `installId`, no `sessionId`, no `userId`,
no prop key or value, no key or key hash, no request body, no IP. `src/log.ts`
has a closed field list that makes this mechanical rather than a matter of
discipline.

---

## 11. Reusing the query layer

Another Worker bound to the **same D1 database** — a dashboard, an internal
report, a scheduled digest — must not re-implement these reads. Every number the
public API serves comes out of `src/lib/queries.ts`, and that module is importable
as-is.

```
src/lib/queries.ts   the read contract: routing, counts, caps, ordering, validation
src/lib/index.ts     the `./lib` entry point (queries + day arithmetic + HttpError)
src/read.ts          HTTP only: auth, query-string parsing, the §8 response envelope
```

`src/lib/` takes a `D1Database` and plain values. No `Request`, no `Response`, no
router, no `Env`, and no Worker-only global touched at module scope, so it also
runs under `vitest`, `wrangler dev`, or plain Node with a D1 client.

### Depending on it

Nothing is published to npm; the package stays `private`. A sibling repo depends
on this directory directly:

```jsonc
// the dashboard's package.json
"dependencies": {
  "stats-worker": "file:../swift-stats/backends/cloudflare"
}
```

…or vendors it as a git submodule / subtree and imports by relative path. Either
way the import is the same:

```ts
import { summary, topEvents, propBreakdown, HttpError } from 'stats-worker/lib';

const { range, rows } = await summary(env.DB, {
  projectId: 'overwatch',
  from: '2026-07-01',
  to: '2026-07-31',
  includeDebug: false,
});
// range.to is the range actually SERVED (a future `to` is clamped to today).
// rows is one row per day, ascending, zero-filled.
```

It is TypeScript **source**, bundled by the consumer's esbuild/wrangler exactly as
this Worker bundles it — there is no compiled copy that can lag behind. A consumer
that cannot read `.ts` can run `npm run build:types` here for `.d.ts` only.

What is exported, and what each thing is for:

| Export | Use |
|---|---|
| `summary(db, {projectId, from, to, includeDebug?, now?})` | per-day `opens` / `sessions` / `activeInstalls` / `events` |
| `topEvents(db, {…, limit?})` | event names ranked by count |
| `propBreakdown(db, {…, name, limit?})` | the §8.2 prop breakdown for one event name |
| `resolveRange(db, {…}, now)` | validate + clamp + resolve the raw/rollup boundary once, to reuse across several queries |
| `summaryRows` / `topEventRows` / `propBreakdownRows` | the same three computations over an already-resolved range |
| `rawBoundaryDay(db, projectId, now)` | the observed raw/rollup boundary |
| `resolveDayRange` / `clampAndValidateDays` | the pure date rules, database-free |
| `parseLimit` / `parseIncludeDebug` / `parseEventName` / `requireBothDays` | the same query-string parsing, so a consumer rejects exactly what the public API rejects |
| `MAX_BREAKDOWN_PROPS`, `DEFAULT_LIMIT`, `MAX_LIMIT`, `MAX_RANGE_DAYS`, `RAW_RETENTION_DAYS` | the documented caps, as values rather than numbers to copy |
| `addDays`, `eachDay`, `today`, `daysInclusive`, `isValidDate`, `rawCutoffDay` | UTC day arithmetic; a range built any other way is a bug (§8.1 buckets by UTC day) |

The convenience functions take an optional `now: Date`. Pass it in tests; leave it
out in production. The clock is never read inside the module.

### What the consumer still owns

**Authorization.** `src/lib/` assumes `projectId` is already authorized —
deliberately, because §8 fixes the check order at *key → scope → dates*, and a
consumer with a different auth model (a session cookie, an operator login) has a
different first step. Do that step first, then call these functions. Reusing this
backend's model is `resolveKey(db, key, 'read')` + `requireScope(scope, projectId)`
from `src/keys.ts`.

**Transport.** Validation failures throw `HttpError`, carrying the same stable
`code` and the same `message` this API returns; `err.toResponse()` produces the
byte-identical §8.3 body if the consumer wants it, and `err.code` is there if it
does not.

### Why not just copy the SQL

Because the read contract is not the SQL — it is the SQL *plus* a dozen decisions
that are invisible until they are wrong. Sessions keyed on `(installId, sessionId)`
and not `sessionId`. The boundary derived from observed state rather than the
clock. A prop cap applied once over merged sources rather than per source. The
null row folding "explicitly null" together with "absent", placed last regardless
of count. `to` clamped before the span check. A copy is correct on the day it is
made and silently diverges afterwards, and a dashboard whose numbers disagree with
the API is worse than a dashboard that is simply down — nothing tells you which one
is lying.

If a computation has to change, it changes in `src/lib/queries.ts` and both sides
move together. `test/queries.test.ts` covers the module directly; `test/read.test.ts`
covers the endpoints over it.

---

## Conformance checklist

Verified at the commit that introduced this file, by `npm test`
(169 tests, `backends/cloudflare/test/`).

### Ingest — `POST /v1/events`

- [x] Accepts the §1 envelope over HTTPS and returns **202** with a small JSON body.
- [x] Returns 202 **only after** `db.batch()` has committed; returns 503 otherwise.
- [x] Requires `X-Stats-Key`; **401** when missing, unknown or revoked.
- [x] **Derives `projectId` from the write key's scope** and stores the derived
      value. Accepts a batch with no `projectId`; **400** on a disagreeing one.
- [x] Treats `userId` as an opaque string; never exposed in the read contract.
- [x] Grants **no read access** to a write key — read endpoints 401 on one.
- [x] Requires `Content-Type: application/json` (charset tolerated); **400** otherwise.
- [x] Rejects an unknown `schema` value with **400** — never guesses.
- [x] Rejects `events: []`, > 100 events, a malformed name, a `stats_`-prefixed
      name, and an object/array props value with **400**.
- [x] Rejects with **400** a batch mixing `appId` or `installId` or supplying more
      than one `projectId`, and any field violating its documented format.
- [x] Rejects a body over 256 KiB with **413**; caps the wire body at 2 MiB.
- [x] **Ignores unknown envelope/event/context keys**; does not extend that into `props`.
- [x] Accepts the consent-reduced context fallbacks of §3.
- [x] Accepts a lowercase `batchId`, uppercasing before keying the dedupe.
- [x] Accepts a batch with more than one `sessionId`, and a `session_end` whose
      `ts` is older than a lower-`seq` event's `ts`.
- [x] Ignores `X-Stats-Read-Key` on the ingest path — never 400/401 on it.
- [x] Accepts an unknown `osName` / `arch`, stored verbatim.
- [x] Deduplicates by `batchId` for 30 days, returning **202** for a duplicate.
- [x] Does **not** dedupe by `(installId, seq)`.
- [x] Tolerates a future-dated or very old `ts` without rejecting the batch.
- [x] Emits `Retry-After` on **429**.
- [x] Never echoes the request body in an error response.
- [x] Sets no cookies and issues no redirects on the ingest path.
- [x] Stores **no client IP**, no derived geography, and no identifier of its own
      invention.

### Read — `GET /v1/summary`, `GET /v1/events/top`

- [x] Requires `X-Stats-Read-Key`, project-scoped; **401** otherwise, with an
      out-of-scope project **byte-identical** to a nonexistent one.
- [x] `date` buckets use the event `ts` in UTC, never `sentAt`, never a local day.
- [x] `/v1/summary` **zero-fills every day** in the served range, ascending.
- [x] `sessions` = distinct `(installId, sessionId)` per day; `activeInstalls` =
      distinct `installId` per day.
- [x] `includeDebug` defaults to **false**.
- [x] Clamps a `to` after today; **400** / `range_too_large` over 400 days; echoes
      the range actually served.
- [x] `/v1/events/top` sorts by `count` desc with the documented tiebreak, honors
      `limit` (total rows without `name`, **per prop** with `name`), returns empty
      `rows` for an unknown `name`, omits numeric props, and folds absent-prop
      into the `null` row.
- [x] Errors use `{"error": "<stable_snake_case>", "message": "..."}`.
- [x] Read endpoints are safe and idempotent — no writes, no side effects.

### Operational

- [x] Documented retention (90 days raw), and it is actually enforced by the cron.
- [x] A documented way to delete all events for one `installId`.
- [x] Rate limiting a well-behaved emitter never trips.
- [x] A conformance suite runnable against a local instance: `npm test`.
