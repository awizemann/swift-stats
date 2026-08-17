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

The Worker carries a per-isolate backstop of 600 batches/minute per project and
emits `Retry-After` on the 429. It is deliberately not the real limit — an isolate
is not a global counter. For a durable limit put a **Cloudflare Rate Limiting
rule** in front of the Worker, keyed on the `X-Stats-Key` header. A well-behaved
emitter following §7 (at most one request in flight, exponential backoff) never
comes close to either.

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

## Conformance checklist

Verified at the commit that introduced this file, by `npm test`
(105 tests, `backends/cloudflare/test/`).

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
