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
