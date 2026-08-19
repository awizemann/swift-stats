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
  `/v1/events/top`; `checkPreAuthRate` takes an optional `limit`.
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
handlers pass `READ_LIMIT_PER_WINDOW`), `README.md` ("Rate limiting").

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
surviving raw events. Ingest writes **one `INSERT OR IGNORE` per batch** covering
every distinct install in it, in the *same* `db.batch()` as the events. The read
side is two functions in `src/lib/queries.ts`: `firstSeenRows` (per-day counts)
and `totalInstalls` (cumulative).

**Why (what is otherwise unrecoverable).** Raw events are deleted at the
retention cutoff, and the rollups that outlive them store per-day **distinct
counts**. A distinct count cannot answer "was this install new that day?". So
first sighting is the one fact that cannot survive retention in any aggregate
form — and it is what retention cohorts, "new vs returning", and every honest
growth number are built out of. Without it a project that has run for a year can
say how many installs were active 200 days ago and can never say how many were
new.

**Why `OR IGNORE` here when §6 argues against it for events.** §6 rejects
`INSERT OR IGNORE` on `events` because it would also swallow the `NOT NULL` /
STRICT-datatype failures that §2 maps to an honest `400`. That argument does not
carry here: the row is three columns the Worker constructs itself, its only
realistic conflict is the primary key, and suppressing it is the entire point —
`OR IGNORE` is what makes `first_seen_day` **immutable**, so the stored day is
the first sighting and never the most recent.

**§13.** This keeps an `install_id` — the SDK's own salted-hash identifier (§9),
not one of this backend's invention — past the raw retention window. That has to
be stated, not discovered: **raw events go at the cutoff; a bare install id and a
day survive.** The erasure obligation still resolves completely
(`delete-install` deletes from `installs` as well as `events`), a project delete
cascades, and **no exported read function returns an install id** — `firstSeenRows`
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

It returns, for that project, **the oldest day whose `first_seen_day` can be
trusted** — `rawCutoffDay(markerDay, project.retention_days)`, the oldest day
that still had raw rows when the migration ran and therefore the oldest day the
backfill's `MIN(day)` could possibly have returned. Read it as:

> installs with `first_seen_day` **≤** this floor may have been first seen
> earlier; everything strictly above it is exact.

Two properties worth stating:

- **`null` means "no floor", i.e. all exact.** A fresh deployment has no marker
  (or ran `0005` against an empty `events`), so there is no backfilled cohort to
  distrust. A consumer must render `null` as "all exact", never as "unknown".
- **It is per project.** The floor comes from the same `retention_days` the sweep
  uses (§9), so a project keeping 180 days has a floor 90 days further back than
  a default one. Deriving it from the global default would mark 90 days of exact
  rows as suspect.

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

**Operational note.** The sweep is now two D1 statements *per project* per
nightly run instead of two globally. Fine at today's scale; remember it at
thousands of projects.

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

-- after `set-retention <id> 180`: that project should still hold raw rows older
-- than the default cutoff, and a default project should not.
SELECT project_id, MIN(day) AS oldest_raw_day FROM events GROUP BY project_id;
```

## 10. The dedupe tally excludes the `installs` statement

**What.** A bug introduced by combining §6 with §8, found and fixed before
release. §6 counts dedupes by walking the `db.batch()` results from
`EVENT_STATEMENTS_FROM = 2` and counting statements reporting
`meta.changes === 0`. §8's `INSERT OR IGNORE INTO installs` is appended **after**
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

### C. A cap on the rollup's expiring-day sweep

`runRollupAndSweep` (`src/rollup.ts`) issues `SELECT DISTINCT day FROM events
WHERE day < cutoff` and rolls **every** returned day before deleting. If the
cron has not run for months this is an unbounded loop inside one invocation. It
is *safe* — the delete is abandoned entirely if any day fails to roll, and the
lease is released in a `finally` — but it can fail to make progress by running
out of time. A cap (roll at most N expiring days per pass, delete only up to the
oldest day actually rolled) would make progress monotonic. Left out because it
changes the retention boundary logic, which is the one irreversible operation in
this backend and deserves its own change with its own tests.

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
- **Migrations are additive.** `0002` rebuilds three tables to add
  `ON DELETE CASCADE`; it is written to run once and `0001` is never edited
  because it is applied on the reference deployment. Follow the same rule.

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
