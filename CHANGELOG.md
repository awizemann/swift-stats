# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **wire schema** in `docs/schema.md` is versioned independently of the
package; schema changes are called out explicitly below.

## [Unreleased]

## [0.2.0] — 2026-08-19

### Upgrade notes (read before adopting)

**Swift packages (`Stats`, `StatsCloudflare`, `StatsTesting`): no breaking
API changes.** Every 0.1.0 call site compiles unchanged; everything new is
additive (`record()`, `drainRecorded()`, `URLSessionTransport.defaultConfiguration()`,
new defaulted parameters). Behaviour changes to be aware of:

- **Low Data Mode:** the default `URLSessionTransport` now sets
  `allowsConstrainedNetworkAccess = false`, so under Low Data Mode batches stay
  queued (and the local queue drops *oldest* past `maxQueued`) until the mode
  lifts. Pass `allowsConstrainedNetworkAccess: true` to keep sending.
- **Timeouts:** 20 s per request / 60 s per resource (previously the
  `URLSession` defaults of 60 s / 7 days).
- **On-disk queue:** an additive sidecar `queue.head` appears next to
  `queue.jsonl`; 0.1.0 queue files load unchanged. Downgrading to 0.1.0 after
  running 0.2.0 re-reads already-sent records (0.1.0 ignores the marker) — the
  backend's per-event idempotency below absorbs that.
- **Directories:** a consumer-supplied `storageDirectory` is no longer re-moded
  to `0700` or excluded from backups — only a directory the SDK creates for
  itself is. The no-Application-Support fallback now uses its own
  `swift-stats-<appId>/` subdirectory under the temporary directory.

**Wire schema `v1` — one normative wording change (no field or envelope
change).** `docs/schema.md` §2.2 and §6 previously said a backend *MUST NOT*
dedupe individual events by `(installId, seq)`. They now say a backend
**SHOULD** treat `(projectId, installId, seq)` as a per-event idempotency key
(first delivery wins), and MUST NOT dedupe on `seq` without `installId` or
across projects. Emitters are unaffected. A third-party backend that
implemented the old MUST NOT is still conformant; the new SHOULD is what closes
the crash-replay case described under "Fixed" below.

**Cloudflare Worker — a migration is required.** `0003_event_idempotency.sql`
adds `UNIQUE (project_id, install_id, seq)` on `events` after collapsing any
pre-existing duplicates (first delivery kept). Run it in a quiet window:
`wrangler d1 migrations apply stats --remote`. Rollups computed *before* the
migration may be inflated by replays and can be re-rolled only while the raw
events are inside the 90-day window. `handleIngest` / `route` now take
`ExecutionContext` (internal signatures; a fork that calls them directly must
pass `ctx`). See `backends/cloudflare/ADOPTION.md` for the full adoption brief
and `docs/SAAS-HANDOFF.md` for the managed-service handoff.

### Added
- Cloudflare Worker: **per-event idempotency.** Migration
  `0003_event_idempotency.sql` adds a unique index on
  `events(project_id, install_id, seq)`; ingest inserts with
  `ON CONFLICT (project_id, install_id, seq) DO NOTHING`, still answers 202,
  and emits a deferred `events_deduped` log line (count only, never bodies)
  when a replay was absorbed. Ephemeral per-session install ids (§11) and
  reinstalls are unaffected because they start a new `installId`.
- `docs/SAAS-HANDOFF.md`: handoff brief for a managed deployment of the engine.
- SDK version drift visibility: `StatsQuery` sends the same constant
  `User-Agent: swift-stats/<version>` header as `CloudflareSink` (fleet-level,
  never per-install — and more private than CFNetwork's default, which names
  the app, build and Darwin version), and the Worker's deferred `batch_accepted`
  log line carries `sdkVersion` from the batch context.
- **`StatsClient.record(_:props:)`** — a `nonisolated`, non-`async` sibling of
  `track()`. Hands the event to the actor through a lock-protected buffer and
  returns immediately: no suspension, no actor hop, safe in a button action or
  a view body. Same validation, sanitization, consent/opt-out checks, and call
  ordering as `track()` (including relative to `track()` calls from the same
  caller); the in-flight buffer is capped at 10,000 entries, past which the
  newest are dropped with a rate-limited log. Added `drainRecorded()` (public)
  so a test or a consumer can wait for everything `record()` has accepted so
  far to reach the queue; `flush()`, `waitForFlushes()`, and `shutdown()` now
  drain it automatically first. The README quick start leads with `record()`.
- **`EventStore.compact()`** — explicit on-demand compaction of the consumed
  prefix, useful to call when idle (e.g. at shutdown).
- **`URLSessionTransport.defaultConfiguration()`** (public, static) — the
  baseline session configuration `URLSessionTransport` uses by default:
  ephemeral, 20s per-request / 60s per-resource timeouts, `.background`
  network service type, and `allowsConstrainedNetworkAccess = false` (a batch
  is not sent at all under Low Data Mode; it stays queued instead). Both
  `allowsConstrainedNetworkAccess` and `allowsExpensiveNetworkAccess` are now
  parameters on `defaultConfiguration(...)` and on `init(...)`'s default-session
  path, so a consumer can opt in to sending under Low Data Mode (or opt out of
  an expensive/cellular link) without hand-building a `URLSessionConfiguration`.
  A consumer supplying a custom `URLSession` can start from the same baseline.
  Documented in a new README "Storage & networking" section.
- Two `package`-visible test seams, unreachable from outside the package:
  `StatsClient.init(configuration:maxRecordedBuffer:)` lets a test overflow
  the `record()` buffer with a handful of calls instead of 10,000, and
  `EventStore.diagnostics` now reports `appends` — the number of `append(_:)`
  calls that have reached the store, which is what makes the batching
  `record()` does upstream (one drained buffer, one append) observable in a
  test.
- Cloudflare Worker: `HEAD` is now routed everywhere `GET` is (`/health`,
  `/v1/summary`, `/v1/events/top`) — `workerd` does not synthesize `HEAD` from
  `GET`, so an uptime checker that defaults to `HEAD` used to get a 405.
- Cloudflare Worker: a separate, tighter pre-auth rate limit for **read** keys
  (`READ_LIMIT_PER_WINDOW = 120`/min) versus write keys (600/min) — a read key
  is one dashboard or script, a write key is a whole fleet, so one number was
  never right for both. The advisory (per-isolate, non-global) nature of these
  in-Worker limits is now documented explicitly in `ratelimit.ts` and the
  backend README.
- `backends/cloudflare/ADOPTION.md`: a new document covering self-hosting
  decisions, including the global-rate-limiting options not implemented here.
- Tests: `Tests/StatsTests/QueueFileTests.swift` and
  `Tests/StatsTests/RecordTests.swift` (`EventStore` compaction/memory-only
  behavior and `record()`/`drainRecorded()` respectively);
  `Tests/StatsCloudflareTests/StatsTransportTests.swift`
  (`URLSessionTransport.defaultConfiguration()`); new Cloudflare Worker tests
  for `ctx.waitUntil`-deferred logging, size- vs. shape-shaped D1 failures,
  the largest legal batch, `HEAD`/method routing, and the read-vs-write rate
  limit split.

### Changed
- **`EventStore`** removal is now a marker update, not a file rewrite. A new
  sidecar file, `queue.head`, records how many leading **bytes** of
  `queue.jsonl` are already consumed, tagged with the file's size at the moment
  it was written; removing a batch updates that ~16-byte marker instead of
  rewriting the whole queue file, and a full rewrite ("compaction") only runs
  once the dead prefix has grown to at least the size of the live remainder.
  This bounds the bytes rewritten to O(1) per removed record, amortized,
  instead of the previous O(n²) cost when draining a large backlog in small
  batches. A byte offset (rather than a line count) is what lets **appending
  skip the marker entirely**: an append only grows the file and never moves a
  byte before the offset, so the marker stays true and `track()` pays one
  `write(2)` with no `stat`, atomic write, rename or `chmod` beside it. A
  marker that cannot be parsed, points past the end of the file, does not land
  on a line boundary, or is tagged with a size the file never reached
  (interrupted write, a recreated file, tampering) is ignored and the queue is
  read from byte zero — safe, never lossy in the direction of skipping unsent
  events; any path that resets or replaces the file deletes the marker rather
  than leaving a stale offset beside it. Live entries are now
  held in an `ArraySlice` rather than an `Array`, so dropping the head no
  longer shifts the remaining elements.
- **`EventStore`** now falls back to memory-only queueing after 3 consecutive
  disk write failures (full volume, read-only container, deleted directory),
  instead of logging and retrying a failing write on every `track()`/
  `record()`. Re-probes the disk every 100 appends (or on an explicit
  `compact()`) and resumes disk-backed queueing automatically once a write
  succeeds again.
- **`EventStore`** now refuses to load a queue file larger than 64 MiB
  (`EventStore.defaultMaxLoadBytes`), discarding it and starting empty rather
  than paying that much RSS on a launch path — such a file is corruption or
  an unbounded-growth bug, not a plausible backlog.
- **`EventStore`** cap-drop warnings are now rate-limited (first drop, then
  every 1,000 after) instead of logging once per dropped event.
- **`EventStore`**'s queue directory is now excluded from backups
  (`isExcludedFromBackup`), set once per process. Everything in the queue is
  disposable analytics, including a hashed `userId` for an install that has
  not yet flushed.
- **`StatsClient`**'s `seq` counter is now cached in the actor and persisted
  once per drain, immediately before the records are handed to the
  dispatcher — instead of being read from and written to `UserDefaults` on
  every single `track()`/`record()` call (an XPC round-trip to `cfprefsd`
  each time). A crash between the in-memory increment and the hand-off can
  only lose a `seq` number, never repeat one (§2.2).
- **`StatsClient`** closes a race where a `setConsent()` revocation or
  `setEnabled(false)` landing while a drain was already suspended handing
  records to the dispatcher could leave those records enqueued under a
  revoked identity; the drain now detects the race (`discardGeneration`) and
  discards again.
- **`StatsClient`**'s identity-store fallback no longer calls
  `preconditionFailure` on an (unreachable in practice) missing store; it
  logs an error and reopens the store instead — a library should not be able
  to crash the host app.
- Cloudflare Worker: a D1 failure that is about the **size** of what was
  asked to be stored (e.g. `string or blob too big`) is now mapped to **413**
  (re-split, per schema §7) rather than folded into the **400** used for
  data-shaped failures (wrong type, `NOT NULL`, `CHECK` constraint) — a 400 is
  a permanent drop, and a batch D1 refused only for being large would
  previously be thrown away when re-splitting it would have worked.
- Cloudflare Worker: post-response work (the success/duplicate log lines, the
  `props`-adjustment log, and the request-body cancel on an early rejection)
  now runs under `ctx.waitUntil` instead of being awaited on the request's
  critical path — the `202` is returned as soon as `db.batch()` commits.
- `backends/cloudflare/README.md` and the ingest conformance checklist updated
  to describe the above: `HEAD` routing, the 413-vs-400 split, the
  `ctx.waitUntil` deferral, and the read/write rate-limit split.

### Fixed
- A client crash in the window between a batch being accepted (202) and its
  local queue marker being written could replay that batch under a *fresh*
  `batchId`, which `batchId` dedupe cannot catch; with the Worker's per-event
  idempotency above, such a replay is now stored once.
- (see the `EventStore` and Cloudflare Worker items above — the O(n²) queue
  drain, the per-event disk-failure log spam, the 400-instead-of-413
  mis-mapping, and the missing `HEAD` route were all bugs, not just
  performance or documentation changes)

## [0.1.0] — 2026-08-17

First tagged release: wire schema `v1`, the `Stats` core emitter, the
`StatsCloudflare` adapter, and the Cloudflare Worker + D1 backend.

### Added
- **`Stats` core client** — the emitter the schema was written for:
  - Value types encoding exactly per schema: `StatsEvent`, `StatsContext`,
    `StatsBatch`, and `StatsValue` (string / int / double / bool / null, with
    literal conformances so `["count": 3, "cached": true, "section": nil]` just
    works). Timestamps are hand-rolled millisecond UTC (`…T14:03:11.482Z`);
    absent optionals and empty `props` are omitted rather than nulled.
  - `StatsClient`, an `actor`: `track(_:props:)`, `identify(userID:)`,
    `setConsent(_:)`, `isEnabled` / `setEnabled(_:)`, `flush()`, `reset()`,
    `applicationDidBecomeActive()` / `applicationDidEnterBackground()`.
    `track()` returns once the event is on disk.
  - `StatsSink` (`nonisolated protocol`, never throws) with `SinkOutcome` =
    `.accepted` / `.retry(after:)` / `.tooLarge` / `.drop(reason:)`, and a
    documented mapping from every §7 HTTP status onto the four.
  - `EventStore`: JSON-lines queue in `Application Support/<appId>/swift-stats/`,
    one append per group of captured events, loaded on start, capped with
    drop-oldest, and carrying the context frozen at track time with each event.
  - `Dispatcher`: flush at N events / T elapsed / on background; batches of
    ≤ 100 events and ≤ 256 KiB (byte limit applied first) that never mix two
    install ids, app ids or project ids (§1); one request in flight via task
    chaining; exponential backoff from 1 s with full jitter, floored at the base
    and capped at 5 minutes, during which no trigger may send; a `.tooLarge`
    re-split into halves with fresh batch ids (§7's 413 row); a 24-hour ceiling
    on *delivery attempts* for a batch, measured on the monotonic clock so a
    long-offline device is not punished for having been offline; `batchId`
    reused across retries of the same batch, and reissued whenever the queue
    head moves under it; permanent drops deleted immediately.
  - Identity per §9: random UUID → salted SHA-256 (CryptoKit) in the SDK's own
    `UserDefaults` suite derived from the app id; `seq` persisted; `reset()`
    regenerates. Sessions per §10 (launch + monotonic inactivity gap, default 30
    min on macOS / 5 min elsewhere, id `<epochSeconds>-<8 digits>`), auto-events
    per §12 in their fixed boundary order, all opt-in.
  - Consent per §11: `usage` / `diagnostics` / `identity`, defaulting to
    `[.usage, .diagnostics]` — opt-**out** by default for an app, whose own
    end-user opt-out is `setEnabled(false)`. `.identity` is never in the
    default, since a stable install id and a `userId` change what the consumer
    must disclose (§14). `consent: .none` still means collect nothing at all,
    down to not creating a queue file. Denying `diagnostics` sends the
    documented fallbacks, denying `identity` switches to a per-session ephemeral
    install id, and any revocation discards the queue and deletes the stored
    install UUID.
  - `StatsClient.init` performs **no disk I/O**: the queue path and the
    `UserDefaults` suite are resolved lazily inside the actor on first use, so
    constructing a client on the main actor during launch is safe and needs no
    `Task.detached`. The queue file is created 0600 and its directory 0700, with
    the mode re-applied on every write (an atomic `Data.write` replaces the file
    and would otherwise carry the umask's 0644).
  - Injected `StatsClock` / `StatsUUIDProvider` / `StatsRandomSource` seams; the
    package never calls `Date.now` or `Task.sleep` directly.
- **`StatsTesting`**: `InMemorySink` (recording, scriptable outcomes),
  `ManualClock` (conforms to both `StatsClock` and the standard `Clock`; a test
  advances it rather than sleeping), `FixedUUIDProvider`, `FixedRandomSource`.
- **`StatsTests`**: 76 tests covering schema encoding round-trips, props
  truncation and the byte-wise 32-key cap, identity hashing and `reset()`,
  session-gap and boundary ordering, consent gating, opt-out, all three flush
  triggers, batch splitting by count and bytes, retry/backoff/drop semantics,
  queue persistence across a relaunch (asserting the frozen context is *not*
  re-stamped by a newer app version), and drop-oldest — plus the pre-existing
  privacy-manifest assertion. No test sleeps.
- Two context fields are **supplied by the consumer** rather than sampled, so the
  core keeps importing nothing but Foundation and `os`: `screenMetrics` /
  `colorScheme` (which would need AppKit/UIKit and a main-actor hop) and
  `isPreRelease` for the context's `isTestFlight` (whose classic
  `Bundle.appStoreReceiptURL` check is deprecated in favor of StoreKit's
  `AppTransaction`). All three default to values §3 and §11 explicitly permit —
  `0` / `0` / `1.0`, omitted, and `false`. Also, `osName` reports `iOS` on
  iPadOS, since distinguishing them requires UIKit.
- Package scaffold: `Stats`, `StatsCloudflare` and `StatsTesting` products,
  `StatsTests` and `StatsCloudflareTests` test targets. Swift tools 6.2,
  language mode 6, `ExistentialAny`, macOS 15 / iOS 18, zero dependencies.
- `Stats.sdkVersion` (`0.1.0`) and `Stats.schemaVersion` (`v1`).
- `Sources/Stats/Resources/PrivacyInfo.xcprivacy`, bundled with the `Stats`
  target: `NSPrivacyTracking` false, no tracking domains, collected data types
  Product Interaction + Other Diagnostic Data (neither linked nor tracking),
  accessed API `UserDefaults` reason CA92.1. A test asserts these values.
- **`docs/schema.md` — wire schema `v1`**: batch envelope, event object,
  per-batch context, size limits, `batchId` idempotency, the
  `POST /v1/events` ingest contract with a normative retry policy, the
  `GET /v1/summary` and `GET /v1/events/top` read contract behind a separate
  read key, identity (salted SHA-256 of a random UUID in the SDK's own
  UserDefaults suite), session policy, consent groups, reserved event names,
  and the never-collected list. Notable contract decisions:
  - `projectId` is **derived by the backend from the write key's scope** and
    never trusted from the client; a client-supplied value that disagrees is a
    **400**. Read keys are project-scoped the same way.
  - An optional, opaque `userId` on the event, set by `identify(userID:)`, hashed
    by the SDK before it leaves the device, and omitted entirely when the
    `identity` consent group is denied. An app that uses it must declare User ID
    in its own privacy manifest — the SDK's manifest does not, because the SDK
    collects no account identifier unless asked.
  - `web` / `wasm32` are reserved for a future JS emitter, which is out of scope
    for `v1`.
- `backends/README.md`: how backends plug in, per-backend README requirements,
  and the shared conformance checklist. `backends/cloudflare/` is reserved with
  its store **decided: D1** — exact distinct counts and indefinite history,
  chosen over Analytics Engine's cheaper approximate writes. Raw events are
  retained 90 days (a MUST for that backend); daily rollups are kept
  indefinitely.
- **`backends/cloudflare/` — the Cloudflare backend (Worker + D1)**, conformant
  to schema `v1` and shipping with its checklist filled in. Ingest on
  `POST /v1/events`, reads on `GET /v1/summary` and `GET /v1/events/top`, and a
  Cron Trigger that rolls up closed days *before* deleting raw events past 90
  days. 140 tests run against a local D1 with no account and no network
  (`npm test`). Notable decisions, all documented in its README:
  - Keys are stored **only as SHA-256 hashes**; the plaintext is printed once at
    mint time and is unrecoverable by design. `scripts/admin.mjs` creates
    projects, mints and revokes keys, and performs the §13 per-`installId`
    erasure.
  - `batchId` dedupe is a D1 primary key inserted in the **same transaction** as
    the events, so a duplicate cannot double-write and there is no
    read-then-write race. Window: 30 days, well past §6's 24-hour minimum, and
    the boundary is asserted rather than assumed.
  - The scheduled job takes an exclusive **lease** before it rolls and sweeps.
    Two overlapping passes could interleave the rollups' delete-then-insert and
    then both delete the same day's raw rows — the one irreversible operation in
    the backend.
  - **Rate limiting** runs pre-auth on all three endpoints, keyed on the SHA-256
    of the presented key and never on the IP (§13), before `resolveKey` costs a
    D1 read. §8.3's 429 is reachable on the read endpoints. The durable global
    limit is a Cloudflare Rate Limiting rule, shipped as documented config.
  - Distinct counts are **exact**, except `/v1/events/top`'s `installs` for a
    range reaching past 90 days, which becomes an upper bound because per-day
    distinct counts are not additive.
  - `events.day` is a clamped bucket column, so a device with a wrong clock can
    neither outlive the retention sweep nor land counts in a future row.
  - `Content-Encoding: gzip` is **not** accepted (400); props size violations are
    **truncated/dropped**, while an object/array props value is always a 400.
- **`Sources/StatsCloudflare`** gains the adapter's shipping surface:
  `StatsQuery` (`GET /v1/summary`, `GET /v1/events/top`, typed rows, §8.3 error
  mapping), `StatsDay` (a UTC calendar day that refuses `2026-02-30` and cannot
  be built from a local day by accident), `CloudflareEndpoint` (HTTPS required,
  loopback exempt per §7), `StatsTransport` (the injectable HTTP seam, which
  declines redirects so a 3xx cannot move the write key), and
  `IngestDisposition.from(statusCode:headers:)` — the whole of §7's retry policy
  as a pure, tested function. `CloudflareSink` is the `StatsSink` conformance:
  it posts `batch.serialized()` (never its own encoding, so the bytes the
  dispatcher size-checked are the bytes on the wire) and maps 413 to
  `.tooLarge`, so the dispatcher re-splits rather than dropping.
- MIT `LICENSE`, `README.md`, this changelog, `.gitignore`, and a GitHub
  Actions workflow on `macos-15` with `DEVELOPER_DIR` pinned to Xcode 26.x,
  running `swift build`, `swift test`, an **iOS Simulator build** (`xcodebuild
  -scheme swift-stats-Package`) so a typo inside an `#if os(iOS)` fork cannot
  ship, and the backend's typecheck and vitest conformance suite.

### Fixed
A pre-release audit pass, all of it behavior-preserving on the wire — `v1` in
`docs/schema.md` is unchanged.

- **Client**
  - `StatsClient.init` no longer does synchronous disk I/O (an
    `applicationSupportDirectory` resolution with `create: true`, plus a
    `UserDefaults` suite open) on the caller's thread.
  - A server `Retry-After` is honored up to the 24-hour retention ceiling
    instead of being clamped to the 5-minute backoff cap. §7 caps the *backoff
    schedule*; a `Retry-After: 1800` used to be truncated to 300 s, so a backend
    shedding load was hit every five minutes by the clients it had asked to stay
    away. Only the floor clamp remains.
  - `StatsTimestamp.date(from:)` rejects `second == 60` and validates
    days-per-month with leap years. Both used to pass and then silently roll
    over, so a queued `2026-02-30` decoded to March 2nd and re-encoded as a
    different string than the one on disk.
  - `StatsConfiguration.contextOverride` and `StatsTesting`'s
    `Duration.statsSeconds` are `package`, not `public`.
  - The queue file is chmod 0600 and its directory 0700.

- **Cloudflare backend**
  - A day no longer reads as **zero while its raw rows exist**. Reads routed
    `day < today - 89` to the rollups, but the sweep runs at 02:10 UTC, so
    between midnight and 02:10 the day `today - 90` still had every raw row and
    was answered from a rollup that may never have been written. The boundary is
    now derived from observed state.
  - `/v1/events/top?name=` answered **500** for any range reaching past raw
    retention: the rollup branch aliased `is_null AS isNull`, and `ISNULL` is a
    postfix operator in SQLite, so it was a syntax error rather than an alias.
  - `seq`, `screenWidth` and `screenHeight` are bounded. `Number.isInteger(1e21)`
    is `true`, so those values passed validation, failed the STRICT INTEGER
    insert, and were reported as a **503** — which §7 makes retain-and-retry, so
    a single malformed event became an infinite retry loop. They are 400s now,
    as is any data-shaped D1 constraint failure that still reaches the handler.
  - The 2 MiB wire cap is enforced by a counting read that aborts the stream at
    the cap, rather than after buffering the whole body. `Content-Length` is a
    claim, and the old order bounded what was kept, not what was read.
  - The §8.2 breakdown prop cap applies to the rollup branch too, and is applied
    once over merged totals — so a mixed range no longer returns a prop set that
    depends on which side of the retention boundary it straddles.
  - New migration `0002`: the rollup lease table, and `ON DELETE CASCADE` from
    the three rollup tables to `projects`, which previously left a deleted
    project's rollups in the database forever. `0001` is not edited.
  - `scripts/admin.mjs` bounds project names and `--label`, and refuses to mint a
    key for a project that does not exist — such a key printed a convincing
    banner and then 401d forever, indistinguishably from a revoked one (§8).
  - `log.ts` maps a caught error to a fixed vocabulary of codes instead of
    logging `cause.message`, which can name a bound parameter value — on the
    ingest path, an `installId`, a hashed `userId`, or a prop value (§13).

- **Tests and docs**
  - Read and rollup date fixtures are derived from today rather than hard-coded
    `2026-08-xx`, which would have crossed the 90-day boundary within months and
    started asserting rollup behavior while claiming to assert raw behavior.
  - The dedupe-retention test asserted `COUNT(*) > 0` after a sweep with nothing
    to purge — true even with the purge removed entirely — and now pins the
    §6 24-hour boundary from both sides.
  - The `StatsCloudflare` smoke test compared `StatsCloudflare.schemaVersion` to
    `Stats.schemaVersion`, which is what it is *defined* as; it asserts the
    literal `v1`.
  - README: the quick start uses `CloudflareSink` rather than an undefined
    `MyHTTPSink`, throwing initializers are wrapped rather than left at file
    scope, the `setEnabled` / `setConsent` install-id asymmetry is documented,
    and the hosted `api.swiftstats.co` paragraph states retention (raw 90 days,
    daily rollups indefinitely), that keys are issued per project by the
    operator, and that hosted sign-up is not open yet.

### Not yet implemented
- Known and accepted: a crash between a `202` and the queue file being rewritten
  re-sends those events under a **new** `batchId` on the next launch, so the
  backend's dedupe cannot suppress them. Delivery is at-least-once by design;
  persisting the in-flight batch id would close this and is a later change.
- One `EventStore` per queue file is assumed. Two `StatsClient`s over the same
  app id (an app plus an extension, say) would interleave `seq` and overwrite
  each other's queue file — there is no file locking in v1.

[Unreleased]: https://github.com/awizemann/swift-stats/compare/0.2.0...HEAD
[0.2.0]: https://github.com/awizemann/swift-stats/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/awizemann/swift-stats/releases/tag/0.1.0
