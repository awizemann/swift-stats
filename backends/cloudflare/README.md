# Cloudflare backend — Worker + D1

A small Worker that serves the whole of [`docs/schema.md`](../../docs/schema.md)
`v1`: ingest on `POST /v1/events`, reads on `GET /v1/summary` and
`GET /v1/events/top`, one-user erasure on `POST /v1/users/erase` (§8.4), and a
nightly Cron Trigger that rolls up closed days and ages out raw events.

Zero dependencies at runtime, one binding (D1), no Worker secrets.

```
POST /v1/events        X-Stats-Key       (write key)  -> 202
GET  /v1/summary       X-Stats-Read-Key  (read key)
GET  /v1/events/top    X-Stats-Read-Key  (read key)
POST /v1/users/erase   X-Stats-Admin-Key (admin key)  -> 200 {done, affected}
GET  /health           (none)
cron 10 2 * * *        roll up closed days, delete raw events past retention, purge expired erase tombstones
```

`HEAD` is accepted wherever `GET` is (workerd does not synthesize it, so it is
routed explicitly); every other method on a path is **405** with `Allow`.

---

## 1. What it stores and where

**D1** (SQLite), one database named `stats`, schema in
[`migrations/0001_init.sql`](migrations/0001_init.sql) plus the additive
migrations `0002`–`0009`.

| Table | Holds | Key / index |
|---|---|---|
| `projects` | tenants | `id` (the wire `projectId`) |
| `keys` | **SHA-256 hashes** of write, read and admin (0009) keys, and `last_used_at` (0004) | `key_hash`; `(project_id, kind)` |
| `batches` | the `batchId` dedupe ledger (§6) | `(project_id, batch_id)` PK — the dedupe *is* the PK |
| `batch_context` | the §3 context, once per batch | `batch_id` |
| `events` | one row per event | `(project_id, day)`, `(project_id, day, name)`, `(install_id)`, `(day)`; `(project_id, user_id)` for rows with a `user_id` (0009) |
| `installs` | first sighting per install (0005) — **outlives the raw purge** | `(project_id, install_id)`; `(project_id, first_seen_day)` |
| `daily_rollups` | per-day `opens` / `sessions` / `activeInstalls` / `events` | `(project_id, day, include_debug)` |
| `daily_event_rollups` | per-day per-event-name `count` / `installs` | `… , name` |
| `daily_prop_rollups` | per-day per-prop-value `count` / `installs` | `… , name, prop, value_type, value_key, is_null` |
| `rollup_state` | what the nightly job rolled, when | `day` |
| `erased_users` | erase tombstones (0009): project, `userId` hash, mode, last erase time — **bounded**, see §10 "Erasing one user" | `(project_id, user_id)`; `(erased_at)` |
| `backend_markers` | one-row-per-fact deployment history (`installs_backfill_day`, 0005) — see §4 | `key` |

`projects.retention_days` (0006) carries each project's raw-event window; see §4.

Four decisions worth knowing before you change anything:

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
- **`installs` is the one table exempt from the retention sweep.** It holds an
  install id and a day, nothing else. First sighting is the only fact no
  aggregate can recover — a per-day distinct count cannot say whether an install
  was *new* that day — so without it, retention cohorts and "new vs returning"
  stop being answerable the moment raw rows age out. What it costs is stated
  plainly in §4 rather than left to be discovered, and `delete-install` clears it
  along with the events.

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

- **Raw events: 90 days by default, per project.** Enforced, not asserted: the
  nightly job deletes `events` rows whose bucket day is older than that project's
  cutoff — per project, one day per statement, and only days it has just rolled
  up for that same project. The read layer routes a day to raw rows only where the
  sweep has actually left them (`rawBoundaryDay`: `today - 89`, or the project's
  oldest surviving raw day when that is older), never by `retention_days` alone — so
  raising a project's window does not turn the days already swept under the old
  one into zeros; they keep reading from the rollups.
- **The window is 90–400 days.** 90 is the default and the minimum: it is what
  §13 documents and what a shorter setting would quietly break, since reads route
  days at the same boundary, so shrinking the window deletes history reads would
  still have served. 400 is the cap, equal to `MAX_RANGE_DAYS` — raw rows kept
  beyond the longest answerable range could never be reached as raw rows anyway.
  Out-of-range stored values are clamped on read rather than rejected by a CHECK,
  so a hand-edited row degrades to 90 instead of triggering a mass delete.

  ```sh
  node scripts/admin.mjs set-retention <projectId> 180 --remote
  ```

  Change the window **only** this way (or with `setProjectRetention` from
  `./lib`). On an increase it also records `projects.raw_complete_from` (0007):
  the days between the new cutoff and the old one were already swept, so their
  rollups are the whole record. Ingest never writes below that marker (a late or
  wrong-clock event lands on it instead), reads never route below it to raw, and
  the sweep never rolls a day below it from raw — it deletes any stray raw rows
  there instead. The marker clears itself once the new window's cutoff passes it.
  A bare `UPDATE projects SET retention_days = …` skips all of that.
- **The nightly pass has a query budget, and so a capacity ceiling.** Every D1
  call is a subrequest to a Cloudflare service, limited per invocation to 1,000
  on Workers Free and 10,000 on Paid; a `db.batch()` counts once
  (developers.cloudflare.com/workers/platform/limits/#subrequests). The pass works
  only on projects that have something to do, least recently visited first, caps
  any one project's backlog at 31 days a night, and stops cleanly before
  `DEFAULT_QUERY_BUDGET` (900) or 10 minutes of wall time (the cron's limit is
  15); the rest go first the next night. A night costs 8 queries plus, per
  project, 1 if it had traffic in the last four days and 1 + *d* if *d* of its
  days expire tonight — so a daily-active project costs 3, and the default budget
  covers about **297 daily-active projects**, though on a busy deployment the
  wall-time limit binds first (ADOPTION.md C). Beyond the ceiling the log line
  `rollup_work_left` reports `rows > 0` every night and the backlog grows. The
  budget can be changed with a `[vars]` entry, `ROLLUP_QUERY_BUDGET` (minimum
  16). On Workers Free the cron's **10 ms CPU limit** may end a pass first: watch
  for `exceededCpu` on the scheduled handler and lower the budget if it appears
  (ADOPTION.md C).
- **One exception to the sweep: `installs`.** One row per install — project, id,
  first-seen day — kept indefinitely, because first sighting cannot be recovered
  from any aggregate (§1). So the honest statement of the retention promise is:
  raw events and everything attached to them go at the cutoff; a bare install id
  and a day survive. `delete-install` removes it, so the §13 erasure obligation
  still resolves completely, and no read path returns an install id — the query
  layer exposes counts per day only (`firstSeenRows`).
- **Backfilled first-seen days are marked, so a reader can label them.** When
  `0005` was applied to a database that already had events, it backfilled
  `first_seen_day` as `MIN(day)` over the raw rows that were still there. For an
  install whose first event had already aged out that is the oldest *surviving*
  day — the install reads as having arrived on the retention boundary. `0005`
  therefore also writes one row into a tiny `backend_markers (key, value)` table,
  `installs_backfill_day` = the UTC day it ran, and the query layer exports:

  ```ts
  firstSeenFloorDay(db, projectId): Promise<string | null>
  ```

  It returns `rawCutoffDay(markerDay, 90)` = `markerDay − 89` — the raw boundary
  as it stood on the day the backfill ran. **Installs with `first_seen_day` ≤
  that floor may have been first seen earlier;** everything above it is exact.
  The floor is the same for every project and deliberately ignores
  `retention_days`: that column did not exist when `0005` ran (`0006` adds it),
  so the backfill's `MIN(day)` could reach back exactly 90 days for everyone, and
  raising a project's window later does not change what the backfill saw.
  Annotate cohort charts that reach back past the floor rather than serving the
  boundary spike as if it were real.

  **A fresh deployment gets a floor too, not `null`.** `0005` writes the marker
  unconditionally, so a database created from scratch carries
  `installs_backfill_day` = the day you ran the migrations, and the floor is that
  day − 89. That is harmless: the backfill had nothing to copy, and under the
  default window ingest clamps an old `ts` to today − 89, so no first sighting
  lands below the floor (one backdated to the migration day itself can land *on*
  it and is labelled conservatively). Only a project whose window you raise above
  90 can store backdated first sightings below it, and those are labelled "may be
  earlier" when they are exact. If you know the database was empty when `0005`
  ran and want every row reported exact, delete the marker:
  `DELETE FROM backend_markers WHERE key = 'installs_backfill_day'`. `null` is
  returned only when the marker row is absent, and should be rendered as "all
  exact", never "unknown".
- **`installs` has no expiry, and that is a decision.** It grows with installs,
  not traffic — three short columns, one row per install ever — and a first-seen
  day that expired at the retention cutoff would answer nothing the rollups do
  not already answer. The honest cost is that for a long-lived popular app this
  is unbounded storage and an unbounded privacy tail, and it belongs in your
  disclosure. If you want a far horizon, the option written down for you is to
  expire rows by the project's own `retention_days` rather than inventing a
  second policy number; `ADOPTION.md` §8.3 has the sketch and the three questions
  to settle before implementing it (chiefly: `installs` has no `last_seen_day`, so
  a correct "not seen in N years" needs one).
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
node scripts/admin.mjs mint-key <projectId> write|read|admin [--label "…"] --remote
node scripts/admin.mjs list-keys <projectId> --remote     # shows hashes, never keys
node scripts/admin.mjs revoke-key <key-hash> --remote
```

`list-keys` includes **`last_used_at`** (migration 0004): when that key last
authenticated a request. It is what makes the rotation below checkable — "has the
old key stopped being used, or am I about to 401 a shipped app?" — and it is the
only thing a request records about itself. The Worker coalesces the write to at
most once per minute per key (D1 bills rows written), so a value up to 60 seconds
stale is expected and does not mean idle; `NULL` means not seen since that
migration ran. A revoked key never updates it, so it freezes at the last live use.

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

**Admin keys** (`ak_stats_…`, migration 0009) are the third kind, and the
narrowest: one grants `POST /v1/users/erase` for its project (§10, "Erasing one
user") and **nothing else** — it 401s on ingest and on both read endpoints, and a
write or read key 401s on erase, all byte-identical to an unknown key. Mint one
only for a project whose app calls `identify()`, and keep it **on a server** —
the one that handles account deletion, in its secret store. It must never ship
inside an app: unlike the write key, which is public by design, an admin key in a
binary lets anyone holding the binary erase any account's link.

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
  ones most often **present** (non-null) in the range, `prop` ascending as a
  tiebreak. The null row does not count toward the ranking: it counts events
  that *lacked* the prop, and ranking on it made every prop on the same days tie.
- A prop's **null row** counts the events of that name that lacked the prop (or
  sent JSON `null`) **on the days the prop was reported at least once**. The
  rollup stores null rows per day for the props seen that day, and the raw path
  applies the same per-day rule, so a range answers the same null row whether its
  days are served raw or from rollups.
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

Raw rows go immediately, and so does that install's `installs` row — which
matters because that table is otherwise exempt from the retention sweep, so
clearing only `events` would leave the id and its first-seen day behind
indefinitely. Rollups for days inside the nightly re-roll window
self-correct on the next pass, because the job is delete-then-insert rather than
an upsert. For an **older** day the rollup still includes that install's
contribution as a number; re-roll that specific day if it matters, and note that
once the day's raw rows are past retention there is nothing left to re-roll from.

**Edge on a project keeping more than 90 days.** Reads route a day older than
`today - 89` to raw rows only if it is at or above the project's *oldest* raw day
(`rawBoundaryDay`). If the erased install owned that project's oldest raw rows,
erasing them moves the oldest raw day forward, and the days in between — which
now have no raw rows at all — are answered from their rollups instead. Those
rollups were written while the install's rows were still there (every day is
rolled while it is in the nightly re-roll window), so they still show its
activity, where before the erasure the same days read the post-erasure raw
numbers. Re-roll those days after a `delete-install` on such a project: with no
raw rows left, a re-roll replaces each day's rollup with an empty one.

### Erasing one user

The §13 obligation for an app that calls `identify()`: honour "delete my
account" for the events linked to it. Two ways, running the same statements
(`src/lib/erase.ts`):

```sh
# From the app's own server, with an admin key (§7):
curl -sS https://<worker>/v1/users/erase \
  -H 'content-type: application/json' -H "x-stats-admin-key: $STATS_ADMIN_KEY" \
  -d '{"projectId":"overwatch","userId":"<64-hex hash>","mode":"unlink"}'
# -> {"done":true,"affected":42}; repeat the identical request while done is false.

# Or as the operator:
node scripts/admin.mjs delete-user <projectId> <64-hex hash> --unlink|--delete --remote
```

**The `userId` is a hash, not the account id.** The SDK never sends the id the
app passed to `identify()`; it sends
`lowercaseHex(SHA256(UTF8(accountID + installIdSalt)))` — no separator — and
that is what `events.user_id` holds. The app's server computes the same value:

```swift
import CryptoKit   // or: StatsConfiguration.hashedUserId(accountID, salt: salt)
let digest = SHA256.hash(data: Data((accountID + installIdSalt).utf8))
let userId = digest.map { String(format: "%02x", $0) }.joined()
```

```js
import { createHash } from 'node:crypto';
const userId = createHash('sha256').update(accountId + installIdSalt, 'utf8').digest('hex');
```

```sh
printf '%s%s' "$ID" "$SALT" | shasum -a 256 | cut -d' ' -f1
```

Check your implementation against the test vector: account id `account-1`, salt
`test-salt` →
`ff0315ef5b57317d76a46521554b19ae36c120ed198f87f718ad7913d79bfa3e`.

- **The salt has to be available to that server.** It is the `installIdSalt` in
  the app's `StatsConfiguration`; it ships inside the app and is not a secret by
  design (§9 — it separates one app's ids from another's, it does not hide them),
  so copying it into the server's config costs nothing.
- **One hash per distinct salt.** If the app has ever shipped with more than one
  salt (two apps in one project, or a salt change between versions), the same
  account produced a different `userId` under each: erase once per salt.
- The endpoint accepts only that shape — 64 lowercase hex — and answers **400**
  `invalid_user_id` for anything else, so a server passing the raw account id is
  told so rather than answered `affected: 0`.

**`unlink` or `delete`.** `mode` is required; there is no default.

- `unlink` sets `user_id` to `NULL` and keeps the events. **Rollups stay exact**:
  none has ever contained a `user_id`, so nothing they count changes. Only
  raw-window *user* figures (a dashboard's `COUNT(DISTINCT user_id)`) stop
  counting this account — which is the point. It suits an app whose promise is
  "we no longer know these events were yours": the link is gone, install and
  event numbers are untouched. **It is final for those rows**: nothing ties them
  to the hash any more, so a later `delete` for the same `userId` cannot find
  them (it deletes only rows linked since — none, under the tombstone). If the
  rows themselves may have to go, choose `delete` from the start.
- `delete` removes the events, and the rollups follow as far as they can. A
  day the delete leaves with **no** raw rows has its rollups (all three tables,
  both `include_debug` variants) deleted in the same batch — nothing else would
  ever correct them, because the nightly sweep only re-rolls days that still
  have raw rows, so the stale rollup would become that day's answer the moment
  it left the raw window. The days are computed in SQL from the chunk's own rows,
  inside the same transaction as the delete. A day is never cleared below the
  project's `raw_complete_from` (§4): there the rollup is the real history and
  raw rows are only late arrivals. A day that still has **other** rows keeps its
  rollup, stale until the next nightly pass re-rolls it (the last few days) or
  until the day ages out and is re-rolled from its raw rows (older days); reads
  serve such a day from its raw rows meanwhile.

**Late events: the tombstone.** Erasing the stored rows is not the end of it: a
device can still hold events captured under the hash — a queue on disk while the
app was offline, or events recorded just before the app called `forgetUser()` —
and a delete frees their `(installId, seq)` identity, so a re-send would be stored
again and re-link the account. So every erase records a tombstone
(`erased_users`: project, hash, mode, time of the last erase call), and ingest
checks a batch's `userId`s against it — one lookup per batch, and none for a
batch with no `userId` — and re-checks inside the insert itself, so an erase
that completes while a batch is in flight cannot leave that batch's rows
linked. Under an `unlink` tombstone the event is stored with no
`userId`; under a `delete` tombstone it is dropped (still answered 202, so the
SDK neither retries it nor logs an error). `delete` beats a later `unlink`.

The tombstone holds the hash — the thing being erased — so it is **bounded**: it
counts for the project's raw-retention window plus **30 days** after the last
erase call (120 days at the default 90), ingest ignores it after that, and the
nightly job deletes it. Ingest accepts events of any age (a too-old `ts` is
clamped into the window, §10), so this bound is a choice, not something the
wire contract implies: a device that holds an unsent queue for longer than that
can still re-link (unlink) or re-store (delete) its own events. Erase again if
that matters for an app whose users go months between launches.

**Bounded and resumable.** Each call erases at most 4 chunks of 5,000 rows and
answers `done: false` if rows may remain. Small on purpose: D1 bounds a
statement's run time, and the database is shared with ingest, reads and the
dashboard — D1 serialises queries, so one long erase would stall all of them.
Repeat until `done: true`. Every call works on "whatever is still linked", so a
retry or a rerun is harmless; after `done` it answers
`{"done": true, "affected": 0}`. `delete-user` loops for you, requires exactly
one of `--unlink` / `--delete`, and can be re-run to resume. The lookup is an
index range on `events_user` (0009), a partial index on `(project_id, user_id)`
for rows that have a user.

**What it does not touch.** Other projects — the same hash in another project is
left alone (§2.5 forbids joining on it). And **`installs`, in either mode**: an
`installs` row is an install id and a first-seen day with no `user_id`, and the
install is not the account's alone — it may hold events from before
`identify()`, or another account's after a sign-out. Deleting it would rewrite
that install's first sighting, and every cohort built on it, for activity never
linked to this account. To erase the install as well, use `delete-install`.
`batches` and `batch_context` carry neither a `user_id` nor an install id and
age out with retention.

### Deleting a project

```sql
DELETE FROM projects WHERE id = '<projectId>';
```

Since `0008` this removes **everything** the project owns, by foreign-key cascade:
keys, raw `events`, the `batches` dedupe ledger, `batch_context`, the three rollup
tables and `installs`. (Before `0008` the three raw tables had no foreign key, so
a project delete left its raw rows behind — unreachable, and never swept.) The
cascade is one statement; for a project with a very large raw backlog it can be
too big for one D1 statement, in which case delete its `events` a day at a time
first (`DELETE FROM events WHERE project_id = ? AND day = ?`) and then the
project row.

### Rate limiting

Two layers, and only one of them is real.

**In the Worker (backstop).** `src/ratelimit.ts` counts requests per minute in a
per-isolate `Map` and throws a 429 with `Retry-After` past the limit:

| Bucket | Limit | Where |
|---|---|---|
| SHA-256 of the presented **write** key | 600/min | **pre-auth**, on `/v1/events` |
| SHA-256 of the presented **read** key | 120/min | **pre-auth**, on `/v1/summary`, `/v1/events/top` |
| SHA-256 of the presented **admin** key | 120/min | **pre-auth**, on `/v1/users/erase` |
| `projectId` | 600/min | post-auth, on `/v1/events` |
| `anonymous` (no key, or one of impossible length) | 600/min | pre-auth, every authenticated path |

Keyed buckets are **per endpoint family**: the same key presented to ingest and
to a read endpoint is counted in two separate buckets. That matters because the
write key is public — it ships in the app binary (§7) — so anyone can present it
to `/v1/summary`; those requests are 401s, and they must not spend the fleet's
ingest bucket.

**What no in-Worker limiter can fix:** the same public write key can be used to
exhaust the app's *own* ingest bucket, by POSTing to `/v1/events` with it. Those
requests are indistinguishable from the app's fleet, so they share its bucket and
its 429s (which the SDK retains and retries, so no data is lost — but delivery
stalls while it lasts). The WAF rule below is the real control for that; the
in-Worker numbers are not.

The read number is six times tighter than the ingest number on purpose: a read
key is **one dashboard or one script** (§8 forbids embedding it in a shipped
app), while a write key is a whole **fleet** — every install of an app presents
the same one. A number chosen as though the ingest bucket were per-device would
429 a popular app's honest traffic, and since §7 makes a 429 RETAIN, that turns
steady traffic into a retry backlog that never drains. Erring high on ingest
costs only that an abusive caller gets more cheap 401s out of one isolate.

Three properties, all load-bearing:

- **The numbers are advisory, not a global ceiling.** The counters are a
  module-scope `Map` in *one isolate*. Cloudflare runs many isolates per colo and
  many colos, and recycles them at will, so the effective global limit is this
  number times an unknown, time-varying number of isolates, and an eviction
  resets a window to zero. Nothing may be built on this being exact — see
  `ADOPTION.md` for the global options and why none of them is implemented here.

- **The bucket key is never the IP.** §13 forbids storing or logging the client
  IP or anything derived from it, and a `Map` keyed on `CF-Connecting-IP` is
  storage — just short-lived. The SHA-256 of the presented key is available
  before authentication, is already what `keys.key_hash` holds, and is
  per-client in the way that matters.
- **It runs before `resolveKey`.** `resolveKey` costs a D1 read, so limiting
  after it would hand a key-guessing loop one free storage read per attempt.

It is deliberately *not* the real limit: an isolate is not a global counter, so a
client spread across isolates sees a multiple of these numbers. Treat it as a
cheap backstop that costs no storage read, and the rule below as the limit.

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

- **Ingest**: 2 + *n* + 1 rows written per batch (the batch row, the context row,
  one per event, and one upsert covering every distinct install in the batch —
  which writes only when it moves that install's `first_seen_day` earlier), plus at
  most one `keys.last_used_at` update per key per minute (deferred under
  `ctx.waitUntil`, so it is off the request's critical path). Context is stored
  per batch, not per event, which is the difference between 2+*n* and 3*n* for a
  typical batch.
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
| `rawBoundaryDay(db, projectId, now)` | the observed raw/rollup boundary: `today - 89`, or the project's oldest surviving raw day when that is older — never below its `raw_complete_from` |
| `setProjectRetention(db, projectId, days, now?)` | the one way to change a project's retention window: moves `raw_complete_from` with it on an increase (§4) |
| `firstSeenRows(db, projectId, fromDay, toDay)` | installs first seen per day — retention cohorts and "new installs"; **counts only, never an install id** |
| `firstSeenFloorDay(db, projectId)` | `installs_backfill_day − 89`, the same for every project (a fresh deployment too); `null` only if the marker row is absent — label cohorts at or below it (§4) |
| `eraseUserChunk(db, projectId, userIdHash, mode, {chunkRows?, maxChunks?, now?})` | records the tombstone, then one bounded slice of a §8.4 erase → `{done, affected, chunks}`; call again while `done` is false. Validates the hash and the mode itself; **authorization is yours** (see below) |
| `totalInstalls(db, projectId, throughDay?)` | installs ever seen, cumulative (a sum over `firstSeenRows` is not the total) |
| `resolveDayRange` / `clampAndValidateDays` | the pure date rules, database-free |
| `parseLimit` / `parseIncludeDebug` / `parseEventName` / `requireBothDays` | the same query-string parsing, so a consumer rejects exactly what the public API rejects |
| `MAX_BREAKDOWN_PROPS`, `DEFAULT_LIMIT`, `MAX_LIMIT`, `MAX_RANGE_DAYS`, `RAW_RETENTION_DAYS`, `MIN_RETENTION_DAYS`, `MAX_RETENTION_DAYS` | the documented caps, as values rather than numbers to copy |
| `clampRetentionDays(raw)` | fold a stored `projects.retention_days` into the supported range — use it rather than trusting the column |
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

## Releasing this backend

The backend is versioned by `package.json` here and released with a
`backend-cloudflare-<version>` tag, independent of the Swift package's `v*`
tags (which SPM resolves — never reuse those for a backend-only release). The
steps, in order, all in ONE commit before the tag:

1. Bump `package.json` `version`.
2. Move the `[Unreleased]` CHANGELOG entries under a
   `## [backend-cloudflare-<version>] — <date>` heading.
3. `npm run typecheck && npm test` — the suite includes `test/release.test.ts`,
   which fails whenever `package.json` and the newest CHANGELOG release heading
   disagree. That guard exists because the two drifted once (the repo tagged
   v0.2.0 while this file still said 0.1.0) and the next release had to skip a
   number.
4. Tag `backend-cloudflare-<version>` on that commit and push the tag with it.
5. Deploy (`wrangler d1 migrations apply … && wrangler deploy`) from the tagged
   commit, never from an unmerged branch or a dirty tree.

Migration numbers are claimed by whatever lands on `main` first; a branch that
was cut earlier renumbers on rebase. Two branches must never both ship the same
`NNNN_`.

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
- [x] Answers **413** (re-split), not 400, when storage refuses a batch for its
      SIZE; **400** only for a shape storage will never accept; **5xx** for
      everything else, so a transient fault always RETAINS the batch.
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
- [x] Does no post-response work on the request's critical path: the 202 is
      returned as soon as `db.batch()` commits, and logging runs under
      `ctx.waitUntil`.
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
- [x] Read endpoints are safe and idempotent: no answer depends on a previous
      request and nothing client-visible changes. The one write on the path is a
      coalesced `keys.last_used_at` touch (§7), at most once per minute per key,
      invisible in the response and scheduled with `ctx.waitUntil` so it runs
      after the response rather than in front of it.

### Operational

- [x] Documented retention (90 days raw by default, 90-400 per project), and it
      is actually enforced by the cron, per project.
- [x] The one table exempt from the sweep (`installs`) is documented, returns no
      ids to any reader, and is cleared by `delete-install`.
- [x] A documented way to delete all events for one `installId`.
- [x] A documented way to delete or unlink all events for one `userId` within a
      project (`POST /v1/users/erase`, `delete-user`), behind an admin key that
      grants nothing else.
- [x] Rate limiting a well-behaved emitter never trips.
- [x] A conformance suite runnable against a local instance: `npm test`.
