# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **wire schema** in `docs/schema.md` is versioned independently of the
package; schema changes are called out explicitly below.

## [Unreleased]

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
  - Consent per §11: `usage` / `diagnostics` / `identity`, default `[]`, denial
    of `diagnostics` sending the documented fallbacks, denial of `identity`
    switching to a per-session ephemeral install id, and any revocation
    discarding the queue and deleting the stored install UUID.
  - Injected `StatsClock` / `StatsUUIDProvider` / `StatsRandomSource` seams; the
    package never calls `Date.now` or `Task.sleep` directly.
- **`StatsTesting`**: `InMemorySink` (recording, scriptable outcomes),
  `ManualClock` (conforms to both `StatsClock` and the standard `Clock`; a test
  advances it rather than sleeping), `FixedUUIDProvider`, `FixedRandomSource`.
- **`StatsTests`**: 65 tests covering schema encoding round-trips, props
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
  days. 105 tests run against a local D1 with no account and no network
  (`npm test`). Notable decisions, all documented in its README:
  - Keys are stored **only as SHA-256 hashes**; the plaintext is printed once at
    mint time and is unrecoverable by design. `scripts/admin.mjs` creates
    projects, mints and revokes keys, and performs the §13 per-`installId`
    erasure.
  - `batchId` dedupe is a D1 primary key inserted in the **same transaction** as
    the events, so a duplicate cannot double-write and there is no
    read-then-write race. Window: 30 days. A duplicate returns 202.
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
  Actions workflow running `swift build` and `swift test` on `macos-15`.

### Not yet implemented
- Known and accepted: a crash between a `202` and the queue file being rewritten
  re-sends those events under a **new** `batchId` on the next launch, so the
  backend's dedupe cannot suppress them. Delivery is at-least-once by design;
  persisting the in-flight batch id would close this and is a later change.
- One `EventStore` per queue file is assumed. Two `StatsClient`s over the same
  app id (an app plus an extension, say) would interleave `seq` and overwrite
  each other's queue file — there is no file locking in v1.

[Unreleased]: https://github.com/awizemann/swift-stats/compare/0.1.0...HEAD
[0.1.0]: https://github.com/awizemann/swift-stats/releases/tag/0.1.0
