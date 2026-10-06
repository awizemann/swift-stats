# Adopting the swift-stats Worker hardening pass

**Audience.** A team running a *managed SaaS* deployment of this Worker/API —
your own fork or deployment of `backends/cloudflare`, serving other people's
apps. This file is written so it can be pasted whole into a coding session as
instructions; it is self-contained and names every file and function.

**Contract.** Everything below is justified against `docs/schema.md` (wire schema
`v1`). Section marks like §7 refer to it. Where this document and that one
disagree, that one wins. The two clauses that drive most of it:

- §7's response table is a **retry policy**, not advice. `5xx`/transport =
  RETAIN and retry, `4xx` = **DROP permanently**, `413` = re-split into new
  batches, `429` = retain and wait `Retry-After`. Getting a status wrong is
  therefore a data-loss bug or an infinite-retry bug, never a cosmetic one.
- §7: "A backend MUST return 202 only once the batch is durable enough that it
  would survive the process dying."

**Ground rules for the whole pass.** No request body is ever logged or echoed
(§7). No client IP, derived geography, or backend-invented person identifier is
stored or logged (§13). Any change that would need a new paid Cloudflare product
belongs in "Recommended, not implemented" below, not in the code.

---

## 1. Post-response work runs under `ctx.waitUntil`

**What.** `fetch()` now receives and threads `ExecutionContext` through the
router into `handleIngest`. All logging that describes an *already-decided*
outcome is scheduled with `ctx.waitUntil` via a new `deferLog(ctx, fn)` helper.

**Why (the risk).** Two failure modes, opposite in direction:

- Work between the D1 commit and `return` is latency the emitter pays for
  nothing, and §7 makes the 202 a durability signal — not a "we also finished
  our bookkeeping" signal. Log emission on a Worker is not free (it is
  serialized and shipped to the observability pipeline), and this is exactly the
  kind of code that grows later — a counter, a KV write, a metrics POST —
  without anyone revisiting where it runs.
- The naive fix, a floating promise, is worse: work started but not awaited and
  not registered with `waitUntil` can be cut off when the response is returned.
  `waitUntil` is the only construct that gives *both* properties.

**Files / functions.**

- `src/log.ts` — new exported `deferLog(ctx, run)`. It swallows throws from
  `run`: bookkeeping must never be able to fail a request that already
  succeeded, and by the time it executes the response has been sent.
- `src/index.ts` — `fetch` now passes `ctx`; `route(request, env, ctx, now)`.
- `src/ingest.ts` — `handleIngest(request, env, ctx, now)`; the
  `props_adjusted` warning, the `batch_duplicate` line and a new
  `batch_accepted` line all go through `deferLog`.

**Before → after.** Before: `fetch` took `_ctx` and ignored it; every log call
was inline and synchronous; there was no success log on ingest at all. After:
the 202 is returned as soon as `db.batch()` resolves, and the three log lines
run after it, guaranteed to complete.

**Durable-before-ack — verify this is still true in your fork.** The 202 is
returned only *after* `await env.DB.batch(statements)` resolves, and the batch
row insert (the §6 dedupe key) is the **first statement in the same
`db.batch()`**. Do not move the write into `waitUntil` "for latency". That would
be a 202 for a batch that may never land, the emitter would delete it from its
queue, and the data is gone.

**Scope, deliberately.** Only ingest was threaded. `src/read.ts` still logs
inline: a read response is not an acknowledgement of anything, there is no queue
behind it, and its log line is genuinely one `console.log`. If you add anything
heavier there — a usage counter, a billing event — thread `ctx` into
`handleSummary` / `handleTopEvents` and use `deferLog` the same way.

**Migration / config.** None.

**Verify.** `test/ingest.test.ts`, describe block
`post-response side effects run under ctx.waitUntil`: it captures `console.log`,
posts a batch, asserts the 202 comes back, then calls `waitOnExecutionContext`
and asserts exactly one `batch_accepted` line exists and that it contains no
`installId`, `userId`, or key. If `deferLog` were a floating promise, the line
would be missing or flaky.

---

## 2. Storage failures map to the status §7 defines for them

**What.** Split the old `isDataShapedFailure` into two classifiers in
`src/ingest.ts`:

| Failure | Status | Emitter behavior (§7) |
|---|---|---|
| `isSizeShapedFailure` — "string or blob too big", `SQLITE_TOOBIG`, "too many SQL variables" | **413** | re-split into smaller batches with **new** `batchId`s, retry |
| `isDataShapedFailure` — datatype mismatch, NOT NULL / CHECK constraint, out of range | **400** | drop permanently |
| anything unrecognized | **503** + `Retry-After` | retain and retry |

**Why (the risk).** The old regex folded `too large` / `string or blob too big`
into the 400 branch. §7 makes a 400 a **permanent drop**, so a batch that D1
refused merely for being *large* was thrown away by the emitter — even though
re-splitting it would have stored it. The largest legal batch is 100 events × 32
props (§5), whose statement payload is several times the 256 KiB body limit, so
this is the realistic case, not a theoretical one. 413 is the status §7 defines
for exactly this, and it is not an infinite-retry risk either: if a single event
still cannot be stored the emitter drops that one event, not the batch.

Note the surrounding invariant, which the pass preserves: **an unrecognized
error message falls through to 503**, so a D1 message-format change costs us the
improvement, never data. And the duplicate-batch question is answered by
`SELECT … FROM batches`, never by matching a driver string, so a message change
cannot turn duplicates into 500s.

**Files / functions.** `src/ingest.ts` — `isDataShapedFailure`,
`isSizeShapedFailure`, and the `catch` in `handleIngest` (size is checked
first).

**Before → after.** Before: `too large` → 400 → data dropped. After: → 413 →
re-split. Data-shaped and unknown failures are unchanged.

**Migration / config.** None. If you run a status-code dashboard, expect a small
new population of 413s that were previously 400s; that is the fix working.

**Verify.** `test/ingest.test.ts`, describe block
`storage failures map to the status §7 defines for them`. It wraps the real D1
in a `Proxy` whose `batch()` throws a chosen message, leaving `prepare()` real
so `resolveKey` and the duplicate SELECT behave normally, then asserts 413 / 400
/ 503 for the three classes, that no events were written on the 413, and that
the error body echoes nothing from the request.

**Audit this yourself in your fork.** The general rule is worth restating: *no
transient condition may surface as a 4xx.* Walk every `throw` on the ingest path
and ask "could a healthy client with a healthy batch hit this while the database
is merely unwell?" If yes, it must be 5xx.

---

## 2a. `isSizeShapedFailure` was tightened to storage-specific messages only

**What.** Narrowed the regex in `isSizeShapedFailure` (`src/ingest.ts`) from
`/string or blob too big|too large|too big|exceeds the limit/i` to
`/string or blob too big|SQLITE_TOOBIG|too many SQL variables/i`.

**Why (the risk).** An independent audit caught that the broad version matched
more than SQLite's own storage-limit messages. A Workers **platform** fault —
a response-size limit or a subrequest-limit error — can legitimately contain
text like "too large" or "exceeds the limit" without D1 having refused to
*store* anything at all. Classifying that as a size failure sends it down the
413 path, and §7's 413 handling is "re-split into smaller batches with new
`batchId`s and retry" — for a **single event** that has no smaller split to
retry as, the emitter's defined behavior is to **drop it permanently**. So the
broad regex could turn a transient platform hiccup into a permanent data loss
for exactly the batches (single-event ones) where re-splitting cannot help,
when the correct answer was 503 (retain, plain retry recovers it). The
narrowed patterns are the specific strings SQLite/D1 use for its own
storage-limit errors, so they no longer catch a platform-level message that
happens to share wording.

**Files / functions.** `src/ingest.ts` — `isSizeShapedFailure` and its doc
comment, updated to spell out why the match must stay storage-specific.

**Before → after.** Before: any cause message containing "too large", "too
big", or "exceeds the limit" → 413, including non-storage platform faults.
After: only D1's own storage-limit phrasings → 413; everything else
(including a platform "too large"/"exceeds the limit" message) falls through
to the existing unrecognized-failure branch → 503 + `Retry-After`, which
retains the batch instead of dropping it.

**Migration / config.** None. If you run a status-code dashboard, expect any
413s that were actually platform faults (not D1 storage refusals) to move to
503 instead; that is the fix working.

**Verify.** `test/ingest.test.ts`, describe block `storage failures map to the
status §7 defines for them`: `413s SQLITE_TOOBIG the same way` (still 413) and
`503s a platform "too large" message that is not about storage, so a single
event is retried rather than dropped` (a message containing "exceeds the
limit" that is not a D1 storage error now asserts 503, not 413).

---

## 2b. The duplicate-check SELECT is guarded, so a D1 outage 503s instead of 500ing

**What.** In `handleIngest`'s `catch (cause)` block (`src/ingest.ts`), the
`SELECT 1 AS ok FROM batches WHERE project_id = ?1 AND batch_id = ?2` lookup —
used to distinguish "this batch already committed" from "this batch failed" —
is now wrapped in its own `try/catch`. On failure it logs a warning (no cause
message, no body) and falls through with `existing = null`, i.e. treated as
"could not confirm a duplicate," which lands on the same 503 + `Retry-After`
path as any other unrecognized failure.

**Why (the risk).** This SELECT runs only after `env.DB.batch(statements)` has
already thrown — i.e. only when D1 has already shown some sign of trouble. If
the trouble is D1 itself being down rather than this one batch being rejected,
the SELECT throws too. Before this fix that second throw was unguarded: it
propagated out of the `catch` block entirely, past every status classification
below it (413 / 400 / 503), and out of `handleIngest` as a raw uncaught error.
That surfaces as a **generic 500 with no `retry-after` header** — which tells
the emitter nothing about whether to retry, unlike the 503 path §7 defines for
"the database, not the data." A caller cannot tell a bare 500 apart from a
permanent server bug, so a healthy batch hitting a transient D1 outage could
be mishandled by the emitter's retry logic in exactly the way §7's status
table exists to prevent.

**Files / functions.** `src/ingest.ts` — `handleIngest`, the `catch (cause)`
block around the duplicate-detection SELECT.

**Before → after.** Before: `batch()` throws, then the duplicate-check SELECT
also throws (D1 down) → uncaught → generic 500, no `Retry-After`. After: the
second throw is caught locally, logged at `warn` with only `{ projectId }` (no
message, no body), and treated as "not a confirmed duplicate" → falls through
to the existing 503 + `Retry-After` branch, same as any other unrecognized
`batch()` failure.

**Migration / config.** None. If you monitor for uncaught exceptions or bare
500s on the ingest path, expect that population to shrink — those cases now
report as 503.

**Verify.** `test/ingest.test.ts`, new test `503s when the duplicate-check
SELECT itself throws, instead of escaping as a bare 500` in the `storage
failures map to the status §7 defines for them` block. It wraps D1 so both
`batch()` and the duplicate-check `prepare(...).bind(...).first()` throw, and
asserts the response is 503 with a `retry-after` header rather than an
uncaught error.

**Audit this yourself in your fork.** Any code added inside this `catch` block
that itself talks to D1 (or any other external service) needs the same
treatment: a fault while handling a fault must still resolve to a §7-defined
status, never propagate as a bare 500.

---

## 3. The rate limiter is advisory — say so, and pick numbers per population

**What.**

- A prominent header comment in `src/ratelimit.ts` stating that the counters are
  per-isolate and therefore **not a global ceiling**.
- A new `READ_LIMIT_PER_WINDOW = 120` applied to `/v1/summary` and
  `/v1/events/top`. (`checkPreAuthRate` first took an optional `limit`; it now
  takes an endpoint, `'ingest' | 'read'`, which picks both the ceiling and a
  separate bucket — see §11.)
- Ingest limits deliberately left at 600/min, with the reasoning written down.
- The README's rate-limiting table updated to match.

**Why (the risk).** Two distinct problems.

*The limiter is not what it looks like.* The counters live in a module-scope
`Map` inside **one** Worker isolate. Cloudflare runs many isolates per colo and
many colos and recycles them at will, so the effective global limit is the
number in the code times an unknown, time-varying isolate count; an eviction
resets a window to zero; two requests a second apart may be counted by different
isolates and so not counted together at all. A SaaS operator who reads "600/min"
as a quota will size capacity wrong and will write support answers that are not
true. The comment is the fix, because the code cannot be.

*One number cannot serve both endpoints.* On ingest the key bucket is a whole
**fleet** — every install of an app presents the same write key, since §7 makes
it public-by-necessity. A read key is **one dashboard or one script**, because
§8 forbids embedding it in a shipped app. Tightening ingest toward a per-device
intuition 429s a popular app's honest traffic, and since a 429 means RETAIN, that
converts steady traffic into a retry backlog that never drains. So: ingest stays
generous (its failure mode is only more cheap 401s from one isolate), reads get
the tight number.

The `anonymous` bucket (no key, or a key of impossible length) keeps the ingest
ceiling on every path: it is shared across all paths, so charging it the tighter
read number would let keyless noise on `/v1/summary` starve keyless requests
elsewhere. Nothing legitimate lands in it — every request without a usable key is
a 401 — so it is a DoS backstop, not a quota.

**Files / functions.** `src/ratelimit.ts` (header comment,
`READ_LIMIT_PER_WINDOW`, `checkPreAuthRate` signature), `src/read.ts` (both
handlers pass `'read'`), `README.md` ("Rate limiting").

**Migration / config.** None in code. **Do** deploy the durable limit: the
README carries a ready Cloudflare Rate Limiting ruleset (WAF → Rate limiting
rules) keyed on the `X-Stats-Key` / `X-Stats-Read-Key` header rather than the IP
— many installs share an IP behind carrier NAT, and §13 keeps this backend out of
the IP business. Keep its response body in the §8.3 shape
(`{"error": "rate_limited", "message": …}`) and its status at 429 so emitters see
the documented contract rather than Cloudflare's block page. Header-keyed
characteristics need a paid plan; on the free plan the rule falls back to IP
keying, which is worse but still outside the Worker.

**Verify.** `test/ingest.test.ts`, `the read limiter is tighter than the ingest
limiter`: fills a read key's bucket to `READ_LIMIT_PER_WINDOW`, asserts
`/v1/summary` 429s, then puts the same count on a write key and asserts ingest
still 202s.

---

## 4. `HEAD` is routed, and `/health` is method-checked

**What.** `HEAD` is accepted wherever `GET` is (`/health`, `/v1/summary`,
`/v1/events/top`); `/health` now 405s a write method instead of answering 200 to
anything.

**Why (the risk).** workerd does **not** synthesize `HEAD` from `GET` — the
request arrives at `fetch` with `method === "HEAD"` and only the response *body*
is stripped on the way out. The previous code carried a comment asserting the
opposite, so every uptime checker defaulting to `HEAD /health` got a 405 and
reported the API as down. `HEAD` is safe and idempotent, so it is allowed on
exactly the routes `GET` is and nowhere else — in particular **not** on
`/v1/events`, which stays `POST`-only.

**Files / functions.** `src/index.ts` — `route()`.

**Migration / config.** None. If you alert on 405s, expect them to drop.

**Verify.** `test/ingest.test.ts`, `HEAD and method routing`.

---

## 5. The maximal legal batch is pinned by a test

**What.** A test ingesting the largest batch §5 permits — 100 events × 32 props,
asserted to be under the 256 KiB body limit — through the real endpoint.

**Why (the risk).** D1's documented limit is on **bound parameters per
statement** (100), not statements per `db.batch()`. This backend's widest
statement is the context row at 19 parameters; each event insert binds 12; the
largest batch is 102 statements. That arithmetic is fine today, and the test is
what makes a platform-limit change fail loudly at exactly the shape that would
find it, rather than in a customer's largest app. A fixture with one event
proves nothing about the case that breaks.

**Files.** `test/ingest.test.ts`, `the largest batch §5 permits (100 events x 32
props)`.

**Migration / config.** None.

**Verify.** It is the test.

---

## 6. Per-event idempotency: `(project_id, install_id, seq)` is UNIQUE

**What.** New migration `migrations/0003_event_idempotency.sql` adds a UNIQUE
index `events_identity` on `events (project_id, install_id, seq)`, collapsing
any pre-existing duplicates first. `handleIngest` (`src/ingest.ts`) now inserts
events with `ON CONFLICT (project_id, install_id, seq) DO NOTHING`, counts the
rows D1 reports as unchanged (`meta.changes === 0`), and emits a deferred
`events_deduped` log line carrying `{ projectId, events, deduped }` — counts
only. The response is unchanged: still `202`, still
`{ "accepted": <events in the batch> }`.

**Why (the risk).** The emitter is 202'd and then writes its local queue marker.
A crash in that window leaves the marker unwritten and the events still queued,
so they are re-sent — and §6 requires a reconstructed batch to carry a **new**
`batchId`. The existing dedupe is keyed `(project_id, batch_id)`, so it cannot
see that: two different batch ids, one set of events, both stored.

Double-counted raw rows would age out at 90 days, but the **rollups are kept
indefinitely**. A replay inflates `opens`, `events`, per-name `count` and every
per-prop `count` for that day permanently, and the raw rows that would let you
recompute the day are gone. That is the asymmetry that makes this worth an
index: the wrong number is the one that outlives its evidence.

**Why this key is safe.** §2.2: `seq` starts at 0 for a fresh install, is scoped
to `installId`, is strictly increasing in the order events were tracked, and is
never reset within an install. So `(installId, seq)` names one event, and
`project_id` scopes it per tenant for the same reason `batches` is scoped.
The two objections both resolve to "a different `install_id`":

- **Reinstall** restarts `seq` at 0 — under a **new** install UUID. Likewise a
  consent revoke and re-grant (§11 deletes the stored UUID; re-granting starts a
  new identity). No collision.
- **`identity` consent denied** (§11) means a fresh **per-session ephemeral**
  install id. Each session is its own `install_id` with its own monotonic `seq`,
  so two sessions that both emit `seq` 0, 1, 2 are eight distinct rows, not
  three. This is the case that would lose the most data under a key that omitted
  `install_id`, and it is covered by a test.

`ON CONFLICT … DO NOTHING` rather than `INSERT OR IGNORE` is deliberate:
`OR IGNORE` suppresses *every* constraint class on the row, including the
`NOT NULL` / STRICT-datatype failures that §2 of this document maps to an honest
`400`. Naming the conflict target keeps the suppression to the identity index.
The batch row's plain `INSERT` stays **first** in the D1 batch, so the §6
duplicate-`batchId` path is untouched: a duplicate batch still aborts the whole
D1 batch atomically and still answers `202 {"duplicate": true}`.

**Why `accepted` still counts the whole batch.** §7's 202 is a durability
statement, not a novelty statement. Every event in the batch is stored exactly
once; reporting the de-duplicated count would read as partial acceptance and
invite the emitter to retry events we already hold.

**Files.** `migrations/0003_event_idempotency.sql` (new), `src/ingest.ts`,
`src/log.ts` (the `deduped` field on `Fields`), `test/helpers.ts` (`seedEvents`
draws `seq` from a suite-global counter so two fixture calls cannot collide),
`test/ingest.test.ts`.

**Migration step.**

```
npm run migrate:local      # or: npm run migrate:remote
```

`0003` is additive and runs once, like `0002`. It is idempotent on its own
terms — the DELETE is a no-op with no duplicates present, and the index is
`IF NOT EXISTS` — but D1 records it as applied either way. Do **not** edit
`0001` or `0002`.

**Verify.**

```
npm run typecheck && npm test
```

Then, against the deployment, confirm the index exists and that nothing violates
it:

```
wrangler d1 execute stats --remote --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND name='events_identity'"

wrangler d1 execute stats --remote --command \
  "SELECT COUNT(*) - COUNT(DISTINCT project_id || ':' || install_id || ':' || seq) AS dupes FROM events"
```

`dupes` must be `0`. In production, watch for `events_deduped` in the logs: a
low, occasional rate is the crash window doing exactly what it is expected to
do. A sustained rate, or a `deduped` that equals `events` on many batches, is an
emitter that is not advancing its queue marker at all — that is an SDK bug, not
a backend one, and the log line is how you see it.

**Operational note — rollups computed before this migration.** The index repairs
`events` only. Any `daily_rollups` / `daily_event_rollups` /
`daily_prop_rollups` row written **before** `0003` may already have counted a
replay, and nothing about adding the index corrects it. If the `dupes` query
above returned a non-zero count before you migrated, then for every day still
inside the 90-day raw window you can re-roll from the (now de-duplicated) raw
events; for days whose raw rows have already been deleted, the inflated rollup
is **not recoverable** and should be treated as an accuracy caveat on that date
range — record it wherever you publish those numbers rather than quietly
serving them. Re-rolling is the ordinary scheduled path re-run for a day; take
the rollup lease into account (`acquireRollupLease`, `src/rollup.ts`) and do not
run it concurrently with the cron.

---

# 0.3.0 — backend additions (migrations `0004`–`0006`)

Everything above is the **0.2.0 hardening pass**: it changed behaviour that was
already wrong. This section is different in kind — three *additive* features,
one migration each, none of which changes the wire schema, the `/v1` shapes, the
error envelope, or any number an existing read already returns. Wire schema
stays `v1`; the Swift package is untouched.

They are numbered `0004`–`0006` because 0.2.0 shipped its own
`0003_event_idempotency.sql` (§6). Apply them in filename order — `0005` in
particular is materially cheaper once `0003`'s index exists, and the numbering
enforces it.

## 7. `keys.last_used_at` — key liveness

**What.** `migrations/0004_keys_last_used_at.sql` adds a nullable
`last_used_at` column to `keys`. `touchKey` (`src/keys.ts`) writes it on every
authenticated request — ingest and both reads — coalesced to **at most one write
per key per minute** (`KEY_TOUCH_INTERVAL_MS = 60_000`, `src/keys.ts:48`). The
CLI shows it: `node scripts/admin.mjs list-keys <projectId>`.

**Why (the risk).** Key rotation is mint-new → deploy → revoke-old, and the
middle step is a guess: there is no way to ask "has anything actually used the
new key yet?" or "is anything *still* using the old one?". An operator either
revokes early and breaks a client that had not shipped, or never revokes at all
and the old key stays live forever. One nullable column turns both questions
into a lookup.

**Why it is a timestamp and not a counter.** A counter is per-request telemetry
about someone else's app; a last-seen timestamp answers the rotation question
completely and answers nothing else. §13 rules out anything person-scale here —
this is scoped to a KEY, which is the operator's own object, not an end user's.

**Off the critical path.** `touchKey` is registered with
`ctx.waitUntil(...)`, not awaited (`src/ingest.ts`, `src/read.ts`) — exactly the
extension §1 anticipates. It is registered *before* body validation, so
"this key authenticated a request" counts every outcome, including a rejected
body. It never throws: it swallows and logs its own failures as
`key_touch_failed`, without the hash. A read-only D1 binding therefore logs and
serves the read, rather than 500ing.

**Note for §8 readers.** `GET /v1/summary` and `/v1/events/top` are no longer
literally write-free. No *answer* depends on it and nothing client-visible
changes, but if you audit the read path against a read-only replica, this is the
one write.

**Files.** `migrations/0004_keys_last_used_at.sql` (new), `src/keys.ts`
(`touchKey`, `KEY_TOUCH_INTERVAL_MS`), `src/ingest.ts`, `src/read.ts`,
`src/index.ts` (threads `ExecutionContext` into both read handlers),
`scripts/admin.mjs` (`list-keys`), `test/helpers.ts`, `test/additions.test.ts`.

**Migration step.**

```
npm run migrate:local      # or: npm run migrate:remote
```

**Verify.**

```
npm run typecheck && npm test
```

Then make one authenticated read and confirm the column moved. Allow a moment —
the write is deferred under `waitUntil`, so it lands just after the response.

```sql
-- key liveness for one project. NULL = never used since 0004 was applied.
SELECT kind, label, created_at, revoked_at, last_used_at
  FROM keys
 WHERE project_id = 'PROJECT_ID'
 ORDER BY last_used_at IS NULL, last_used_at DESC;
```

A key you are about to revoke should show a `last_used_at` that has stopped
advancing. Revocation freezes the value rather than clearing it, so it remains
readable as "last live use" afterwards.

## 8. `installs` — first-seen day, surviving the raw purge

**What.** `migrations/0005_installs.sql` adds
`installs (project_id, install_id, first_seen_day)`, PK `(project_id,
install_id)`, `ON DELETE CASCADE` to `projects`, plus the
`installs_first_seen (project_id, first_seen_day)` index, and backfills it from
surviving raw events. Ingest writes **one upsert per batch** (originally
`INSERT OR IGNORE`; see §11) covering
every distinct install in it, in the *same* `db.batch()` as the events. The read
side is two functions in `src/lib/queries.ts`: `firstSeenRows` (per-day counts)
and `totalInstalls` (cumulative).

These count `install_id`s, so they are only install counts for emitters that
grant `identity` consent. The SDK's default consent grants it (§11), so a
default-configured app sends one stable `install_id` per install. An app that
configures or records `identity` denied gets its own `install_id` every
session, so its install-based metrics (installs, active installs, first-seen
installs, retention) count sessions. A stable install needs `.identity`
granted, not `identify(userID:)`.

**Upgrade break.** SDK releases before the per-install default denied
`identity` unless the app granted it. When an app that never recorded consent
upgrades, its numbers change at that point: installs and active installs drop
from session counts to real install counts, and every existing device writes
one new `installs` row, appearing as a first-seen install in the upgrade week.
Retention cohorts and new-versus-returning figures that span the upgrade are
not comparable.

**Why (what is otherwise unrecoverable).** Raw events are deleted at the
retention cutoff, and the rollups that outlive them store per-day **distinct
counts**. A distinct count cannot answer "was this install new that day?". So
first sighting is the one fact that cannot survive retention in any aggregate
form — and it is what retention cohorts, "new vs returning", and every honest
growth number are built out of. Without it a project that has run for a year can
say how many installs were active 200 days ago and can never say how many were
new.

**Why an upsert that only moves the day earlier.** This first shipped as
`INSERT OR IGNORE`, on the reasoning that suppressing the primary-key conflict
made `first_seen_day` immutable — the first sighting, never the latest. But
"first to arrive" is not "first seen": §1's offline queue can deliver today's
batch before the one queued three days ago, and the install then read as new
today, forever. It is now
`ON CONFLICT (project_id, install_id) DO UPDATE SET first_seen_day =
excluded.first_seen_day WHERE excluded.first_seen_day < installs.first_seen_day`
— the minimum over every sighting, independent of arrival order, and still a
no-op for any later sighting. (The §6 argument against `OR IGNORE` on `events`
— it swallows `NOT NULL`/STRICT failures — never applied to this three-column
row the Worker builds itself; the change is about arrival order, not that.)

**§13.** This keeps an `install_id` — the SDK's own salted-hash identifier (§9),
not one of this backend's invention — past the raw retention window. That has to
be stated, not discovered: **raw events go at the cutoff; a bare install id and a
day survive.** The erasure obligation still resolves completely
(`delete-install` deletes from `installs` as well as `events`), a project delete
cascades to `installs` (and, since `0008`, to the raw tables too — before it, a
project delete left `events`, `batches` and `batch_context` behind), and **no exported read function returns an install id** — `firstSeenRows`
returns counts per day, and there is no code path in the read contract that
returns one. Both READMEs disclose the exemption; a self-hoster's own privacy
policy may need the same sentence.

### 8.1 The backfill is index-assisted — apply `0003` first

The backfill is `SELECT project_id, install_id, MIN(day) FROM events GROUP BY
project_id, install_id`, which touches every surviving raw row. §6's
`events_identity` UNIQUE index on `(project_id, install_id, seq)` has exactly
that grouping key as its **prefix**, so SQLite walks the index in grouping order
instead of scanning `events` and building a temporary b-tree. The filename
ordering already guarantees `0003` is applied first; do not reorder them.

Get the row count before you apply, and watch this statement:

```sql
SELECT COUNT(*) AS raw_rows FROM events;
```

### 8.2 Backfilled `first_seen` is marked, so a reader can label it

The backfill is honest but was, initially, **unmarked** — and that is a real
defect rather than a nicety. For an install whose first event has already aged
out, `MIN(day)` is the oldest *surviving* day, so the install reads as having
arrived on the retention boundary. Nothing in the data said which rows those
were, so a cohort chart drawn across the migration date shows a spike at the
boundary that a consumer cannot tell from a real one. It would simply be wrong,
confidently.

`0005` therefore also creates a deliberately tiny

```sql
CREATE TABLE backend_markers (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
```

and writes one row, `installs_backfill_day` = `date('now')`, in the same
migration as the backfill so the marker and the rows it describes cannot
disagree. Nothing in the request path reads it; every value in it is a fact about
the deployment's *history*, not a setting.

The reader-facing half is one exported helper:

```ts
firstSeenFloorDay(db: D1Database, projectId: string): Promise<string | null>
```

It returns **`rawCutoffDay(markerDay, 90)` = `markerDay − 89`**, the oldest day
that still had raw rows when the migration ran and therefore the oldest day the
backfill's `MIN(day)` could possibly have returned. Read it as:

> installs with `first_seen_day` **≤** this floor may have been first seen
> earlier; everything strictly above it is exact.

Three properties worth stating:

- **It is the same for every project.** `retention_days` did not exist when
  `0005` ran (`0006` adds it), so the backfill's reach was 90 days for everyone;
  a project's current (or later raised) window does not move the floor.
- **A fresh deployment gets a floor too, not `null`.** `0005` writes the marker
  unconditionally, including over an empty `events` table, so the floor is the
  day you ran the migrations − 89. Harmless: under the default window ingest
  clamps an old `ts` to today − 89, so no first sighting lands below it (one
  backdated on the migration day itself lands *on* it and is labelled
  conservatively); only a project raised above 90 days can store backdated, exact
  first sightings below it, and they err the same safe way. An operator who knows
  the database was empty when `0005` ran may delete the marker row.
- **`null` means only "no marker row", i.e. all exact.** A consumer must render
  `null` as "all exact", never as "unknown".

Not a `first_seen_is_exact` column on `installs`: that would be a per-row flag
carrying one repository-wide fact, and it would have to be written for every
future row forever to stay true.

### 8.3 `installs` is kept indefinitely — the decision, and the option

**Decided: `installs` has no expiry today, and that is intentional.** It is the
only table exempt from the retention sweep, and the exemption is the point — a
first-seen day that expired at the retention cutoff would answer nothing the
rollups do not already answer. The table grows with **installs, not traffic**: a
busy install costs exactly what a silent one does, three short columns, one row
per install ever. The removal paths that exist are the ones §13 requires:
`delete-install` for a single erasure, and `ON DELETE CASCADE` for a project.

**The honest cost:** for a long-lived popular app this is unbounded storage and
an unbounded privacy tail, and "we keep a bare install id forever" is a sentence
that has to appear in your disclosure.

**The documented option, if you want a far horizon.** Expire rows by the
project's own `retention_days` (§9) rather than inventing a second policy
number. This is *not* implemented — it is written down so the shape is agreed
before anyone needs it:

```sql
-- NOT IMPLEMENTED. A far-horizon trim, per project, run from the same nightly
-- job as the raw sweep. `installs` has no `last_seen_day`, so this can only be
-- expressed against observed activity — which is why it is an option and not a
-- default.
DELETE FROM installs
 WHERE project_id = ?1
   AND install_id NOT IN (SELECT install_id FROM events WHERE project_id = ?1);
```

Three things to settle before implementing it, and the reason it is deferred:

1. That statement deletes any install with **no surviving raw events**, which on
   a 90-day window is every install that went quiet three months ago — far too
   aggressive to be a default, and it would delete exactly the historical
   cohorts the table exists to preserve.
2. A genuinely correct version needs a `last_seen_day` column on `installs`
   (one more write per batch, or a nightly `MAX(day)` pass) so the horizon can be
   "not seen in N years" rather than "not seen this quarter".
3. Whatever you choose, the erased rows change past cohort numbers, so it must be
   disclosed the same way the retention cutoff is.

**Files.** `migrations/0005_installs.sql` (new: table, index, backfill,
`backend_markers`), `src/ingest.ts`, `src/lib/queries.ts` (`firstSeenRows`,
`totalInstalls`, `firstSeenFloorDay`), `scripts/admin.mjs` (`delete-install`),
`test/helpers.ts` (`seedInstalls`, `installs` and `backend_markers` in the reset
list), `test/additions.test.ts`.

**Migration step.** As above — but read §8.1 first and get the `events` row
count. This is the one statement in the whole pass that touches every surviving
raw row.

**Verify.**

```sql
-- rows exist after the backfill, and the marker was written
SELECT COUNT(*) AS installs FROM installs;
SELECT key, value FROM backend_markers;

-- the backfill agrees with the events it was derived from
SELECT COUNT(*) AS mismatched
  FROM (SELECT project_id, install_id, MIN(day) AS d FROM events GROUP BY 1, 2) e
  JOIN installs i USING (project_id, install_id)
 WHERE i.first_seen_day <> e.d;

-- no install may be first seen in the future, or before its own events
SELECT COUNT(*) AS impossible FROM installs WHERE first_seen_day > date('now');
```

`mismatched` must be `0` immediately after the migration. It legitimately becomes
non-zero later, in one direction only: once raw rows age out, `MIN(day)` rises
while `first_seen_day` correctly stays put.

## 9. `projects.retention_days` — per-project raw retention

**What.** `migrations/0006_project_retention_days.sql` adds
`retention_days INTEGER NOT NULL DEFAULT 90` to `projects`. The nightly sweep,
`bucketDay`'s clamp and the read layer's raw/rollup boundary (`rawBoundaryDay`)
all resolve it per project. Bounds are **90–400**, enforced by
`clampRetentionDays` (`src/dates.ts`) on every read of the column and by the CLI
on write: `node scripts/admin.mjs set-retention <projectId> <days>`.

**Why (the risk).** The window was one constant compiled into the Worker, which
is not a policy a multi-tenant deployment can hold: two projects in one database
could not want different windows, and the only way to give one a longer one was
to redeploy and silently give it to **everybody** — including projects whose §14
disclosure said 90 days.

**Why those bounds.** The minimum is 90 because a shorter window is not a storage
tweak: `bucketDay` clamps an implausibly old `ts` onto the oldest surviving day
and reads route at the same boundary, so shrinking it deletes history the read
layer would still have served. The maximum is 400 = `MAX_RANGE_DAYS`: a read may
span at most 400 days (§8.1), so raw rows kept beyond that could never be reached
as raw rows — only billed.

**Why clamp-on-read rather than a `CHECK`.** SQLite cannot add a `CHECK` to an
existing table without rebuilding it, and rebuilding `projects` means dropping a
table three others have foreign keys into. Clamping is also the safer failure
mode: a hand-edited `5` becomes a 90-day window rather than an immediate mass
delete.

**What does not change.** Rollups are still kept indefinitely, the
roll-**then**-delete order is still not negotiable, and each day is still served
from exactly one source. What changed is that the boundary those three agree on
is resolved per project — and no sweep crosses a project boundary any more.

**Operational note.** The sweep is per project — and, since §11, so is the
rollup, with one delete statement per expiring project-day. Fine at today's
scale; remember it at thousands of projects.

**Read-boundary correction (§11).** "The boundary those three agree on is resolved
per project" was true of the sweep and the clamp but wrong for reads:
`rawBoundaryDay` used the project's *clock* cutoff, so raising a project from 90
to 180 days routed the 90 days already swept under the old window to raw rows
that no longer existed — zeros, with the rollups holding the real numbers. Reads
now route on observed raw rows (see §11).

**Files.** `migrations/0006_project_retention_days.sql` (new), `src/dates.ts`
(`clampRetentionDays`, `MIN_RETENTION_DAYS`, `MAX_RETENTION_DAYS`,
`rawCutoffDay`/`bucketDay` take the window), `src/rollup.ts` (per-project sweep),
`src/lib/queries.ts` (`rawBoundaryDay`), `scripts/admin.mjs` (`set-retention`),
`test/helpers.ts` (`setRetention`), `test/additions.test.ts`.

**Migration step.** As above. `ADD COLUMN` with a `NOT NULL` constant default,
which SQLite applies without a table rewrite, so **every existing project keeps
exactly the 90 days it already had** and nothing changes until you run
`set-retention`.

**Verify.**

```sql
-- every project reads as 90 immediately after the migration
SELECT id, retention_days FROM projects ORDER BY id;

-- nothing outside the enforced bounds (the code clamps, but a hand-edited row
-- should be found and fixed rather than silently folded on every read)
SELECT id, retention_days FROM projects WHERE retention_days < 90 OR retention_days > 400;

-- Raise retention ONLY with `admin.mjs set-retention` or `setProjectRetention`
-- (src/retention.ts): both move `raw_complete_from` (0007) in the same UPDATE.
-- after `set-retention <id> 180`: that project should still hold raw rows older
-- than the default cutoff, and a default project should not.
SELECT project_id, MIN(day) AS oldest_raw_day FROM events GROUP BY project_id;
```

## 10. The dedupe tally excludes the `installs` statement

**What.** A bug introduced by combining §6 with §8, found and fixed before
release. §6 counts dedupes by walking the `db.batch()` results from
`EVENT_STATEMENTS_FROM = 2` and counting statements reporting
`meta.changes === 0`. §8's `installs` write (then `INSERT OR IGNORE`, now an
upsert with the same zero-changes behaviour on a known install) is appended **after**
the events in the same batch, and when it hits a *known* install it reports zero
changed rows in exactly the same way a deduped event does. The loop is now
bounded at both ends:

```ts
const EVENT_STATEMENTS_FROM = 2;
const EVENT_STATEMENTS_TO = EVENT_STATEMENTS_FROM + batch.events.length;
```

**Why it mattered.** Left alone, **every returning user** would have been counted
as a replayed event. `events_deduped` — the one signal §6 tells operators to
watch as evidence of an SDK bug — would have read as a sustained replay on
perfectly healthy traffic, and the healthier the traffic (more repeat users) the
worse the false signal. It is worth noting that this is the failure mode §6
itself warns about, arriving from the opposite direction: an alert that is wrong
in the direction of *always firing* is as useless as one that never does.

**The test that would have caught it.** The existing "does not log
`events_deduped` when nothing was deduped" case could not: it ingests a single
batch into a freshly reset database, so its `installs` insert really does change
a row. The new case ingests **two** batches from the **same** install and asserts
the second reports no dedupes —

> *`installs` is excluded from the dedupe tally: a returning install reports
> `deduped=0`* (`test/additions.test.ts`)

— which fails with `{"event":"events_deduped","events":1,"deduped":1}` if the
loop bound is reverted to `results.length`.

**Files.** `src/ingest.ts`, `test/additions.test.ts`.

**Verify.** `npm test`, then in production watch `events_deduped` exactly as §6
describes. The line should be absent on ordinary repeat traffic; low and
occasional is the crash window working as designed; sustained, or
`deduped === events` across many batches, is an emitter not advancing its queue
marker.

---

## 11. Cross-project integrity of the nightly job and the read boundary

**What.** One audit and its follow-up review, ten fixes, each with a failing test first
(`test/integrity.test.ts` unless noted).

1. **Rollups are per project** (`rollupStatements(env, day, rolledAt,
   projectId)`). The rollup was DELETE-then-INSERT for a whole *day* across every
   project. Since `0006` windows differ per project, so the night a 180-day
   project expired a day, the re-roll also deleted a 90-day neighbour's rollup
   for that day and rebuilt it from raw rows swept 90 days earlier — nothing.
   The same happened the night after one project's delete failed, and after a
   `set-retention` change. Both halves are now scoped to `project_id`, and the
   trailing re-roll and the expiring-day roll iterate `projects`.
2. **`0008_raw_tables_cascade.sql`** rebuilds `events`, `batches` and
   `batch_context` with `REFERENCES projects(id) ON DELETE CASCADE` (columns,
   STRICT, the AUTOINCREMENT `id` and its counter, and all seven indexes
   including `events_identity` preserved), copying only rows whose project
   exists. Before it, a project delete left orphaned raw rows; the day-wide
   rollup then failed its FK into the rollup tables for any day with one, which
   failed the whole day's batch and skipped retention for **every** project,
   every night. The job now also ages out orphans below the oldest live cutoff
   (an index range that is empty in the steady state, not a nightly
   `NOT IN` scan) for a Worker deployed ahead of the migration. `0005`'s
   backfill gained `WHERE project_id IN (SELECT id FROM projects)`: `OR IGNORE`
   does not cover a foreign-key failure, so one orphaned event aborted it.
3. **`rawBoundaryDay`** is `min(oldest raw day, today - 89)` — the second term
   being the newest day *any* sweep can ever have deleted — instead of the
   project's clock cutoff. Raising retention no longer turns already-swept days
   into zeros. Quiet projects keep the old behaviour (older days from rollups).
   It is also capped from below by `raw_complete_from` (item 9).
4. **The §8.2 prop cap ranks by presence.** It summed value rows **and** the null
   row, which counts events *lacking* the prop, so every prop reported on the
   same days tied and byte order dropped the frequent one. The raw branch's own
   `LIMIT` is gone (the cap is applied once, over merged totals), and the raw null
   row now uses the rollup's per-day rule, so a day gives the same null row from
   either store.
5. **Per-project isolation in the sweep.** Each project's sweep has its own
   `try/catch`; a trailing-roll failure skips only that project's delete. Each
   expiring project-day is rolled and deleted in **one `db.batch()`** — atomic,
   so a day is rolled and gone or neither — not a `LIMIT`/rowid loop, because a
   chunked delete interrupted mid-day leaves a partial day that the next night
   would re-roll over a complete rollup. The delete re-checks the project's
   *current* window in SQL, so a `set-retention` raise that lands mid-pass makes
   it a no-op rather than deleting days the new window keeps; the moot-marker
   clear is decided in SQL from the current row for the same reason.
6. **`installs.first_seen_day`** is an upsert that only moves earlier (§8).
   Test: out-of-order batches.
7. **Rate-limit buckets are per endpoint** (`checkPreAuthRate(key, now,
   'ingest' | 'read')`). The public write key presented to a read endpoint used
   to spend its fleet's ingest bucket. The README now says plainly that the same
   key can still exhaust its own ingest bucket via `/v1/events`, and that the WAF
   rule is the control for that.
8. **Tests.** The misnamed "still rejects a data-shaped failure" ingest case is
   renamed for what it checks (a duplicate `batchId` still aborts the batch) and
   a real data-shaped case added; the "a read writes nothing" cases compare the
   full contents of every table (`snapshotDatabase` in `test/helpers.ts`) rather
   than `COUNT(*) FROM events`.

9. **`raw_complete_from` (`0007`): a retention increase no longer treats swept
   days as raw.** Fix 3 alone left a hole the audit probed: after 90 → 180, one
   legitimate late batch for a day D that the old window had already swept
   (inside the new one) wrote a raw row into D; `rawBoundaryDay` dropped to D, so
   every day between D and `today - 89` read raw — false zeros — and the night D
   expired under the new window the sweep re-rolled D from that lone row, replacing
   its real rollup. Wrong-clock events clamped onto the new cutoff did the same.
   `0007` adds `projects.raw_complete_from`, set by **`setProjectRetention`**
   (`src/retention.ts`, exported from `./lib`) and by `admin.mjs set-retention`
   (identical SQL) on an increase, to the old clock cutoff — or the project's
   oldest raw day if older, since an unswept day is complete. The effective raw
   floor is `max(rawCutoffDay(now, retention_days), raw_complete_from)`
   (`rawFloorDay`, `src/dates.ts`), used by ingest clamping (`bucketDay`), by
   `rawBoundaryDay` (never routes below it to raw) and by the sweep (raw rows
   below it are deleted **without** being rolled — the rollup is authoritative).
   The sweep clears the marker once the clock cutoff passes it. **Do not raise
   retention with a bare `UPDATE projects SET retention_days`** — that skips the
   marker. The only other writer found: the hosted dashboard
   (`swiftstats.co`) reads `retention_days` but does not write it (its tests
   UPDATE it directly, which is fine for reads). If it ever offers a retention
   setting, it must call `setProjectRetention`.
10. **The nightly pass has a per-invocation query budget.** D1 caps queries per
    Worker invocation (1,000 Cloudflare-service subrequests on Workers Free,
    10,000 on Paid — see C below), and the pass used to issue roughly 8 per
    project plus 8, every night, regardless of
    whether a project had anything to do. Now: one query picks the projects with
    work (raw rows or rollups in the trailing window, or raw rows below their
    cutoff), ordered by `projects.rolled_at` (`0007`, last *visited* by a pass,
    never-visited first). Idle projects cost nothing and are not written. A
    project's whole trailing re-roll is one batch; each expiring day is one
    roll-and-delete batch; a project's expiring days per night are capped at
    `sweepDaysCap` (25% of the budget, at most `MAX_SWEEP_DAYS_PER_PROJECT` = 31,
    which bounds one tenant's share of the night's wall time), after which it is
    marked visited
    and goes to the back, so a deep backlog (400 → 90 is 310 days) drains a slice
    a night without starving anyone. The pass stops cleanly before
    `DEFAULT_QUERY_BUDGET` (900, or the `ROLLUP_QUERY_BUDGET` var) and before 10
    minutes of wall time (`PASS_WALL_BUDGET_MS`), always keeping
    its fixed tail (bookkeeping, purges, lease release) in hand; a project the
    budget did not reach stays unvisited and goes first the next night. Each
    project's `rolled_at` is written inside its own last batch (its trailing
    re-roll, or each expiring-day batch), not in the tail, so a pass killed
    part-way still rotates the projects it worked on. The budget is clamped to at
    least `MIN_QUERY_BUDGET` (16). Work left
    over is logged as `rollup_work_left` (`rows` = projects not reached, `events`
    = projects with backlog left) — alert on it being non-zero for several
    nights. `rollup_state`'s cross-project `COUNT` is one statement per pass.
    Tests: twelve projects on a small budget are all rolled and swept across
    nights, each night within budget and making progress; fresh traffic every
    night cannot starve later projects; a 300-day backlog drains while its
    neighbour's yesterday is rolled every night; idle projects cost no queries;
    a raise injected mid-pass neither loses raw rows nor loses its marker.

**Migration step — `0007` with the deploy, `0008` scheduled.**

`0007` is two `ADD COLUMN`s: instant, no rewrite. **The new Worker code needs
it** (`resolveKey` and the nightly pass read its columns) — deploy without it and
every request fails. The code does **not** need `0008`: it rolls and sweeps
around orphans without it.

The two were numbered this way so the cheap one can go first, but **wrangler
cannot stop part-way**: `wrangler d1 migrations apply` (and so `npm run deploy`,
which runs it) applies every pending migration, in order, with no option to stop
after one. So either:

- **Apply both together**, after rehearsing `0008` as below — `npm run deploy`
  does exactly that; or
- **Apply `0007` alone and record it, then deploy the Worker without `migrate`,
  and schedule `0008`.** Rehearsed against a local database with wrangler 4:

  ```sh
  # 1. run 0007's statements
  wrangler d1 execute stats --remote --file migrations/0007_raw_complete_from.sql
  # 2. record it as applied, so `migrations apply` never runs it twice
  wrangler d1 execute stats --remote \
    --command "INSERT INTO d1_migrations (name) VALUES ('0007_raw_complete_from.sql')"
  # 3. confirm only 0008 is pending
  wrangler d1 migrations list stats --remote
  # 4. ship the Worker WITHOUT `npm run deploy` (which would migrate everything)
  wrangler deploy
  # 5. later, in a quiet window, after the checks below
  wrangler d1 migrations apply stats --remote
  ```

  `d1_migrations` is wrangler's own bookkeeping table (`id`, `name`,
  `applied_at` defaulting to now); step 2 is exactly the row `migrations apply`
  would have written. Add `--config wrangler.prod.toml` to each command if that
  is how you address the real database.

**Projects whose retention was raised BEFORE this release** have no
`raw_complete_from`, and so none of its protection for the days their old window
had already swept. Set it by hand to the old clock cutoff on the day of the
raise — **raise day − (old window − 1) days** — for any project where that date
is still later than today's cutoff for its current window (today − (new window −
1) days); otherwise the old swept days have aged out already and there is
nothing to protect:

```sql
-- raised from 90 to 180 days on 2026-09-20: the old cutoff that day was 2026-06-23
UPDATE projects SET raw_complete_from = date('2026-09-20', '-89 days') WHERE id = '<projectId>';
```

Use that computed date even if the raise happened between 00:00 and the 02:10
sweep, when a day or two below it still had raw rows: treating those days as
swept only means they are read from, and kept as, their rollups — which exist,
because every day is rolled while it is in the trailing re-roll window.

Know what a hand-set marker does to LATE rows: from then on, ingest clamps a
late or wrong-clock event for any day below it onto the marker day, and raw rows
already sitting below it (written before you set it) are **deleted with the
raw data when they expire and are NOT added to those days' rollups** — the
rollups below the marker are taken as complete and never rebuilt from raw. That
is the point (a stray row must not replace a day's history), but it means a
genuine late batch that landed below the marker before you set it is dropped
from the aggregates. A marker the clock cutoff has already passed is harmless;
the next pass clears it.

`0008` rebuilds the three raw tables. Before applying it to a real deployment:

- **Storage peaks at roughly 2× `events` + its indexes** while the copy and the
  old table coexist, until the `DROP`. Check headroom against your database
  size limit (500 MB Free, 10 GB Paid).
- **It is one atomic request.** D1 runs the migration file as one transaction,
  and a request is limited to 30 seconds of query duration; a large `events`
  table can exceed that (or the Worker CPU behind it) and fail — harmlessly,
  since it rolls back, but it will not have run. On Workers Free it also spends
  rows written against the daily limit (every raw row, plus every index entry,
  once).
- **Ingest stalls while it runs**: D1 is single-writer, so batches queue behind
  it and retry (§7 retains on 5xx). Run it well away from the 02:10 UTC cron and
  from your traffic peak.
- **Take a Time Travel bookmark first**: `wrangler d1 time-travel info stats`
  prints the current bookmark; note it, so `wrangler d1 time-travel restore
  stats --bookmark=<it>` can undo the migration (retention: 7 days Free, 30
  Paid).
- **Rehearse on a copy**: `wrangler d1 export stats --remote --output dump.sql`,
  load it into a local database (`wrangler d1 execute stats --local --file
  dump.sql`), then `wrangler d1 migrations apply stats --local` and time it.

It rewrites every surviving raw row once — count `events` first. Check orphans
beforehand if you want to know what it will drop:

```sql
SELECT 'events' AS t, COUNT(*) FROM events WHERE project_id NOT IN (SELECT id FROM projects)
UNION ALL SELECT 'batches', COUNT(*) FROM batches WHERE project_id NOT IN (SELECT id FROM projects)
UNION ALL SELECT 'batch_context', COUNT(*) FROM batch_context WHERE project_id NOT IN (SELECT id FROM projects);
```

**Not recoverable by this change:** rollups already wiped by the old day-wide
re-roll. Their raw rows were gone before the wipe, so there is nothing to
re-roll from.

---

# 0.5.0 — erasing one user (migration `0009`)

Additive: one endpoint, one key kind, one migration. Wire schema stays `v1`
(§8.4 and a §13 sentence are new); nothing an existing read returns changes.

## 12. `POST /v1/users/erase`, admin keys, and the erase tombstone

**What.** An app that calls `identify()` can have its server erase one user's
events in one project — `unlink` (null `user_id`) or `delete` (remove the rows),
in bounded slices of 4 × 5,000 rows per call — with a new `admin` key kind
(`ak_stats_…`) that grants that and nothing else. Each erase writes a tombstone
(`erased_users`) that ingest consults so late events cannot re-link the hash,
kept for the project's window plus 30 days. The logic is
`src/lib/erase.ts`, exported from `stats-worker/lib` as `eraseUserChunk`; README
§10 "Erasing one user" is the operator view.

**Migration `0009`.** It rebuilds `keys` (the `kind` CHECK gains `'admin'`; rows,
columns, cascade and `keys_by_project` are copied unchanged), creates
`events_user` — `CREATE INDEX … ON events (project_id, user_id) WHERE user_id IS
NOT NULL` — and creates `erased_users`.

- **Apply `0009` before deploying EITHER Worker.** The D1 database is shared
  with the hosted dashboard (swiftstats.co). This Worker's new code needs
  `erased_users` on every ingest that carries a `userId` (the lookup fails, and
  ingest answers 503 — retained, not lost — until the table exists), and the
  dashboard's copy of the lib needs it for erase. Apply it with this repo's
  `npm run migrate:remote` (the dashboard's `app_*` migrations do not include
  it), then deploy this Worker, then the dashboard.
- **Rehearse the index build on a large `events` table.** `CREATE INDEX` reads
  every row of `events` once inside the migration's transaction (writing index
  entries only for rows that have a `user_id`). Check `SELECT COUNT(*) FROM
  events` first, as §8.1 suggests for `0005`, and run the migration against a
  copy of a production-sized database before the real one.
- **Rollback after `0009` is safe.** The rebuilt CHECK is a superset of the old
  one, so a previous Worker reads and writes `keys` exactly as before (it never
  mints or resolves `admin`); `events_user` and `erased_users` are simply unused
  by it. What a rollback loses is the tombstone check on ingest — late events
  for an erased hash would be stored linked again until the new code is back.

**The dashboard must learn the `admin` kind.** Its copy of the key format
(`swiftstats.co/src/keys.ts`) has `KeyKind = 'write' | 'read'` and picks the
prefix with `kind === 'write' ? … : …`, which would mint an admin key as
`rk_stats_…`. Before it offers admin keys it needs the `ak_stats` prefix, a
badge for the kind wherever keys are listed, the kind in its per-kind key counts
(`settings.ts` counts only `write` and `read`, so admin keys are silently
uncounted today), and the setup wizard must **reject** an admin key wherever it
asks for a write or read key. Its project delete needs no change: `erased_users`
cascades from `projects`, though naming it explicitly would match how that code
treats every other table.

## Recommended, not implemented

Each of these is a real improvement we deliberately left out of the code, with
the reason. For a managed SaaS deployment the first is the one that matters.

### A. A genuinely global rate limit

The in-Worker limiter is advisory (item 3) and the WAF rule is per-zone config
an operator has to apply. Two in-code options:

1. **Cloudflare's Workers Rate Limiting binding** (`[[ratelimit]]` in
   `wrangler.toml`, `env.LIMITER.limit({ key })`). Cheapest by far: no storage
   read, no extra request, and it is enforced outside the isolate. It is
   documented as best-effort and *per-colo*, so it is a large improvement over
   per-isolate but still not one global counter. Key it on the SHA-256 of the
   presented key, never the IP (§13). **This is the recommendation** for a SaaS
   deployment.
2. **A Durable Object per key bucket.** Genuinely global and exact, and it also
   gives you a place to hang per-tenant quota accounting. The costs are real: a
   DO round-trip on *every* request including the pre-auth path the current
   design exists to keep cheap, a new binding, and a single-threaded object in
   front of your hottest endpoint — the thing an abusive client would then aim
   at. Only worth it if you are billing on request volume and need the number to
   be defensible.

Not implemented here because both add a binding, and the reference deployment's
constraint is "one binding (D1), no secrets". Whichever you pick, keep the
in-Worker `Map` as the free first line — it costs nothing and it is what answers
a burst that arrives inside a single isolate.

### B. Per-tenant quotas and billing counters

A SaaS deployment needs "this project has used N events this month", which the
current backend cannot answer cheaply — `batches.event_count` exists but nothing
aggregates it. A monthly rollup table written by the same cron, keyed
`(project_id, month)`, is the natural place. Left out because it is product
surface, not hardening, and because §13's posture means you should decide
deliberately what you retain.

### C. A cap on the rollup's expiring-day sweep — and the pass's capacity

**Done for the query count (§11 item 10); still open for CPU and wall time.**

**The limits that bind the nightly pass**, from
developers.cloudflare.com/workers/platform/limits (checked 2026-10-05):

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Subrequests to Cloudflare services (each D1 call) per invocation | 1,000 | 10,000 (configurable) |
| Cron Trigger wall time | 15 min | 15 min |
| Cron Trigger CPU time | 10 ms | 30 s (daily cron) |
| One D1 query or `db.batch()` (developers.cloudflare.com/d1/platform/limits) | 30 s | 30 s |
| Bound parameters per statement | 100 | 100 |

Every D1 binding call is a subrequest to a Cloudflare service; a `db.batch()` is
one binding call, so it counts once however many statements it carries. (The
50-per-request subrequest figure on Free applies to external `fetch` only. The D1
limits page still lists "50 / 1,000 queries per Worker invocation" while pointing
at these same subrequest limits; the Workers page is the current statement.)

**Capacity, in those units** (one per `run`/`all`/`first`, one per `db.batch()`):

```
fixed per night = 8      (lease, project select, 6-query tail)
per project     = 1      if it has rows or rollups in the trailing 4 days
                + 1 + d  if it has d days expiring tonight
                         (d ≤ min(31, 25% of the budget): sweepDaysCap)
```

A daily-active project past its first window has one day expiring every night,
so it costs **3**. At the default budget of **900** (headroom under Free's 1,000)
that is **(900 − 8) / 3 = 297 daily-active projects** before work carries over to
the next night; a project younger than its window costs 1. On Workers Paid,
`ROLLUP_QUERY_BUDGET` can go higher — but the next ceiling is **wall time**, not
queries: the pass stops starting new work after `PASS_WALL_BUDGET_MS` (10 min of
the cron's 15), and a re-roll is a heavy batch (`json_each` over a project-day's
props, six DELETE-then-INSERTs). At ~0.5–2 s per batch, 10 minutes is roughly
300–1,200 batches, so on a busy deployment wall time binds before a 900 budget
does. Either way, past the ceiling `rollup_work_left` shows `rows > 0` night
after night and the backlog grows; that is the signal to shard the pass.

**CPU on Workers Free is 10 ms per cron invocation — the most likely way a Free
pass ends early.** D1 round trips are I/O and do not count, but building the
statements does (about a dozen per project-day, plus JSON handling of each
result). It is not measured here. When the limit is hit the invocation is
terminated mid-pass with an `exceededCpu` outcome: the tail does not run and the
lease is only freed when its 30-minute TTL lapses (well before the next night).
Nothing is lost — every batch is atomic, a day is rolled-and-deleted or neither,
and each project's rotation (`rolled_at`) is written inside its own batches
rather than in the tail, so the projects that did get work move to the back and
the next night starts with the rest. Watch Workers Logs / the dashboard's
invocation status for `exceededCpu` on the scheduled handler (or
`scheduled_done` going missing); if it shows up, lower `ROLLUP_QUERY_BUDGET` until
it stops, or move to Workers Paid (30 s CPU for a daily cron). The budget cannot
be set below `MIN_QUERY_BUDGET` (16): under that a night has no room for even one
project's work after the fixed cost, so it would never rotate.

The pass stops before its budget (or its wall-time budget) and resumes the next night in
least-recently-visited order, and progress is monotonic: every finished day is
rolled and deleted, every unfinished one whole. What it does not bound is CPU and
wall time per query — each rollup batch runs `json_each` over one project-day's
props, and one huge project-day can approach the 30-second ceiling on its own.
Sharding a single project-day is the next step if that ever happens; it is not
needed at the reference deployment's scale.

### D. Alerting on the scheduled job

`scheduled()` catches everything and logs `scheduled_failed`; nothing pages. The
rollup silently not running is invisible until raw retention removes a day that
was never aggregated — permanent loss. Wire a Cloudflare Logpush / Workers
Analytics alert on the absence of a daily `scheduled_done`, and on
`retention_skipped` / `retention_skipped_unrolled_day`, which are the two lines
that mean "the sweep declined to delete". Not code, so not in the diff.

### E. Key rotation ergonomics

Keys are stored as SHA-256 only (`src/keys.ts`, table `keys`), which is right,
and rotation is an INSERT plus an UPDATE — no redeploy. A SaaS deployment should
expose that as a self-service flow with an overlap window (mint the new key,
ship the app update, revoke the old one only when the old build's traffic has
decayed). Revoking before the fleet updates is a 401, and §7 makes a 401 a
**permanent drop** — that is a data-loss incident caused by an admin action, so
the UI must say so.

**Partly answered since 0.3.0.** §7's `keys.last_used_at` supplies the fact that
overlap window needs — "has the new key been used yet?" and "has the old key gone
quiet?" — so the decay can be observed rather than guessed. The self-service flow
and the warning copy are still yours to build.

### F. Things we checked and deliberately did **not** change

Recorded so you do not re-litigate them:

- **Key comparison is not constant-time, and should not be.** We never compare a
  stored secret to a presented one; we hash the presented key and do an indexed
  equality lookup on the hash (`resolveKey`). A timing signal leaks at most
  something about a SHA-256 digest. What *would* need a constant-time compare is
  storing keys in plaintext and using `===` — do not adopt that design.
- **Body is read only after auth.** `handleIngest` checks `Content-Type`,
  `Content-Encoding`, the pre-auth rate limit and `resolveKey` *before*
  `readBody`, and `readBody` counts bytes as they arrive against a 2 MiB wire cap
  rather than buffering then measuring. Keep that order; it is what stops an
  unauthenticated caller making you allocate.
- **`X-Stats-Read-Key` on the ingest path is ignored** — not 400, not 401 — per
  §7, because both are permanent drops. There is intentionally no code that
  looks at it.
- **401 is one constructor with one fixed message** (`src/errors.ts`), so
  "missing key", "revoked key", "wrong kind of key", "project you may not see"
  and "project that does not exist" are byte-identical. §8 requires this; it is
  easy to break by adding a helpful message.
- **Nothing person-scale is logged, and driver messages are never logged
  verbatim** (`classifyError` in `src/log.ts` maps a throw to a fixed code).
  SQLite constraint messages can name bound parameter values, which on this path
  are `installId`s and prop values.
- **`wrangler.prod.toml` holds no secrets** (there are none — keys live hashed
  in D1) and is git-ignored at the repo root. Keep it that way; the only reason
  it is ignored is the real D1 id and route, not credentials.
- **Migrations are additive.** `0002` and `0008` rebuild tables to add
  `ON DELETE CASCADE`; each is written to run once, and `0001` is never edited
  because it is applied on the reference deployment. Follow the same rule. The
  one deliberate exception is a guard added to `0005`'s backfill (§11): D1
  records applied migrations by name, so the edit is invisible where `0005` has
  run and is what lets a deployment that has not run it get past it.

---

## Acceptance

From `backends/cloudflare/`:

```
npm ci            # if node_modules is missing
npm run typecheck
npm test
```

Both must pass with no new warnings. The suite runs against a real local D1
(workerd + miniflare) applying the **real migration files**, not a hand-written
test schema — keep it that way, because a suite that builds its own tables passes
while the migration that ships is wrong.
