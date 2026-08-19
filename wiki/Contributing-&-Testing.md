---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: .github/workflows/ci.yml, Sources/StatsTesting, Tests
source_paths_inferred: false
---

# Contributing & Testing

## Building

### macOS (library + tests)

```bash
swift build --build-tests
swift test
```

### iOS (compile check only)

CI does not run tests on iOS — there is no way to boot a simulator and run
`swift test` against a generic destination — it only asserts that the package
**compiles** for iOS. That matters because platform forks (`#if os(iOS)`,
e.g. `StatsEnvironment`'s `osName`/device-model branch, and
`StatsConfiguration`'s default session gap — 30 minutes on macOS, 5 minutes
everywhere else) are never type-checked by a macOS-only build, so a typo in
the untaken branch can sit broken indefinitely. The exact command, from
`.github/workflows/ci.yml`:

```bash
xcodebuild \
  -scheme swift-stats-Package \
  -destination 'generic/platform=iOS Simulator' \
  build
```

`swift-stats-Package` is the aggregate scheme SwiftPM generates; one
invocation builds `Stats`, `StatsCloudflare` and `StatsTesting` together.

### Cloudflare Worker

```bash
cd backends/cloudflare
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run — local D1 inside workerd, no account, no network, nothing deployed
```

Other scripts in `backends/cloudflare/package.json`: `dev` (`wrangler dev
--local`), `migrate:local` / `migrate:remote`, and `deploy` (runs remote
migrations, then `wrangler deploy`).

## What CI runs, and why

`.github/workflows/ci.yml` has two jobs:

- **`build-and-test`** (`macos-15`): pins Xcode 26.x explicitly rather than
  trusting whatever `xcode-select` defaults to. The package is
  `swift-tools-version: 6.2` in language mode 6, so it needs Xcode 26; a
  runner image quietly bumping its default Xcode should fail here with a
  clear message, not somewhere inside a compile log. `Xcode_26.0.app` is
  preferred if present; otherwise the newest installed `Xcode_26*.app` is
  selected; anything outside 26.x is a hard failure. This job runs
  `swift build --build-tests`, `swift test`, then the iOS compile-check build
  described above.
- **`cloudflare-backend`** (`ubuntu-latest`, Node 22): `npm ci`, `npm run
  typecheck`, `npm test` from `backends/cloudflare/`.

## Test philosophy

Swift Testing only (`@Suite` / `@Test` / `#expect`), no XCTest. No real
sleeps or timing-dependent waits anywhere in the suite — every source of
non-determinism is replaced by an injected seam from `Sources/StatsTesting/`:

- **`ManualClock`** — conforms to both `Stats`' own `StatsClock` and the
  standard `Clock` protocol. Nothing waits in real time: `sleep(for:)`
  suspends until a test calls `advance(by:)`, which moves the wall clock and
  the monotonic clock together and resumes any sleeper whose deadline has
  passed. `requestedSleeps` records every duration ever requested — how a
  test asserts a backoff schedule (`1, 2, 4, 8…` seconds) without waiting for
  it. `waitForSleepers(count:)` yields (never sleeps) until the expected
  number of sleepers has registered, so a test cannot advance past a deadline
  that has not been set yet. `cancelAllSleepers()` resumes everything still
  waiting, for teardown.
- **`FixedUUIDProvider`** (`StatsUUIDProvider`) — hands out a supplied list of
  UUIDs in order, then a fixed fallback once the list runs out, so an
  accidental extra UUID request shows up as a repeated value in an assertion
  rather than as a random flake. `issued` records everything handed out.
- **`FixedRandomSource`** (`StatsRandomSource`) — deterministic session-id
  digits that advance by one per call (so two sessions starting in the same
  wall-clock second still get distinguishable ids) and a fixed jitter
  fraction (`1.0` by default, making full jitter equal its unjittered
  ceiling).
- **`InMemorySink`** (`StatsSink`, an `actor`) — records every `StatsBatch`
  handed to `send`, including repeated attempts of a retried batch, and
  answers from a scripted `[SinkOutcome]` list (`setOutcomes` replaces the
  script mid-test, e.g. "fail twice, then start accepting"). `sentEvents`,
  `sentEventNames` and `batchCount` are convenience readouts.

`SinkOutcome` is `.accepted`, `.retry(after: Duration?)`, `.tooLarge`, or
(drop cases) as defined in `Sources/Stats/StatsSink.swift` §7 of the schema
governs which HTTP status maps to which outcome for the Cloudflare adapter.

### The test harness

`Tests/StatsTests/TestHarness.swift` defines `Harness`, the shape every
`StatsTests` suite builds a client from: one isolated client per test, with
its own app id (hence its own `UserDefaults` suite), its own queue file on
disk (a temp subdirectory named after the app id), its own `ManualClock`, and
a scripted `InMemorySink`. Isolation is what lets the suite run in parallel
and lets a test assert on persisted state without another test's leftovers.
`Harness.tearDown()` shuts the client down, releases anything still suspended
on the manual clock, deletes the queue directory, and removes the
`UserDefaults` persistent domain. `Harness.relaunched(...)` builds a second
client over the same app id and directory to simulate an app relaunch.

### A minimal test, in the real shape

```swift
import Testing
@testable import Stats
import StatsTesting

@Suite("Example: interval flush")
struct ExampleTests {
    @Test("An interval flush sends whatever is queued")
    func intervalFlush() async {
        let harness = Harness(flushAt: 100, flushInterval: .seconds(30))

        await harness.client.track("example_event")
        #expect(await harness.sink.batchCount == 0)

        #expect(await harness.clock.waitForSleepers(count: 1))
        harness.clock.advance(by: .seconds(30))
        #expect(await harness.yieldUntil { await harness.sink.batchCount == 1 })
        #expect(await harness.sink.sentEventNames == ["example_event"])

        await harness.tearDown()
    }
}
```

This mirrors `Tests/StatsTests/DispatchTests.swift`'s `intervalTrigger` test
almost line for line — that file, and `Harness` itself, are the best
reference for the real API when writing a new test.

## Suite map

`Tests/StatsTests/` (against `Stats` + `StatsTesting`):

| File | Covers |
|---|---|
| `ConcurrencyTests.swift` | One request in flight; concurrent `flush()` calls never double up; a count-trigger firing mid-flush doesn't fork a second request. |
| `ConsentTests.swift` | Default consent, `.none`, per-group denial (usage/diagnostics/identity), `identify()` under denied identity, revoking vs. granting a group, persisted choice winning over configuration, `enabled` behavior. |
| `DispatchTests.swift` | Count and interval flush triggers, backgrounding, the 100-event / 256 KiB batch caps, retry backoff and batchId reuse, `Retry-After` handling and clamping, 413 re-splitting, oversized single events, drop outcomes, retention ceiling, queue survival across relaunch, the `maxQueued` cap. |
| `EncodingTests.swift` | Wire encoding against schema §2/§4 examples, optional/empty omission, timestamp format and rejection rules, calendar-day validation, `StatsValue` domain round-tripping, rejecting nested props. |
| `IdentityTests.swift` | `installId` derivation (SHA-256 of the UUID + salt), stability across relaunch with `seq` continuing, `reset()` semantics, `identify()` hashing before it leaves the device, the dedicated `UserDefaults` suite. |
| `PropsTests.swift` | String truncation to 200 scalars, the 32-key cap with byte-wise key ordering, non-conforming key/value dropping, non-finite number handling, explicit null survival, event-name validation rules. |
| `QueueFileTests.swift` | The consumed-prefix marker, compaction thresholds, marker corruption/staleness handling, relaunch behavior, degraded-disk fallback to memory and recovery. |
| `RecordTests.swift` | `record()` ordering and `seq` assignment under load, interleaving with `track()`, behavior after `shutdown()`, revocation racing in-flight drains, the `maxRecordedBuffer` drop policy. |
| `SessionTests.swift` | Session id format, the session gap (30 min macOS / 5 min elsewhere), auto-events, session-boundary event ordering (`session_end`, `session_start`, `app_open`), reserved/malformed name rejection. |
| `StatsSmokeTests.swift` | SDK/schema version constants; the privacy manifest is bundled. |
| `StorageTests.swift` | Lazy storage creation, the other trigger point (`applicationDidBecomeActive()`), consent `.none` creating no storage, queue file permission bits (0600) across an atomic rewrite. |

`Tests/StatsCloudflareTests/` (against `StatsCloudflare` + `StatsTesting`):

| File | Covers |
|---|---|
| `CloudflareSinkTests.swift` | §7 ingest: request shape, write key, 202 handling, the full status → outcome mapping, `Retry-After` passthrough, transport failure treated as retry-not-drop. |
| `IngestDispositionTests.swift` | The §7 response table in isolation, including the nested `429 and Retry-After` suite (integer parsing, case-insensitivity, backoff fallback, clamping to the retention ceiling). |
| `StatsCloudflareSmokeTests.swift` | Adapter/core schema version agreement; documented endpoint paths are stable. |
| `StatsDayTests.swift` | The `StatsDay` UTC-day type: parsing, zero-padding, calendar/leap-year validation, ordering, inclusive span counting, wire encoding. |
| `StatsQueryTests.swift` | The §8 read contract: decoding example responses, URL/header construction, error-code mapping (401/400/404/429/5xx), local validation (`to` before `from`, the 400-day span cap), and `CloudflareEndpoint`'s HTTPS-only requirement. |
| `StatsTransportTests.swift` | `URLSessionTransport.defaultConfiguration()` defaults (timeouts, service type, cookie/cache policy) and explicit overrides. |
| `StubTransport.swift` | Test double (not a suite). |

## Contribution rules

From the README's Contributing section, two rules that keep the project
coherent:

1. **The schema comes first.** A change that affects the wire format changes
   `docs/schema.md` in the same PR. A breaking change needs a new schema
   version (`v2`), never an edit to `v1`.
2. **No new dependencies in `Stats`.** The package builds on Foundation, `os`,
   CryptoKit (the install-id hash), and Synchronization (the `record()`
   buffer) only — zero third-party dependencies, and nothing that adds a
   required-reason API beyond `UserDefaults`. `StatsCloudflare` and
   `StatsTesting` depend only on `Stats`.

Two conventions worth knowing when reading or adding to the source:

- **Isolation is explicit everywhere.** `Package.swift` deliberately omits
  `.defaultIsolation(MainActor.self)`: a library has to state its own
  isolation (`nonisolated`, `actor`, `@MainActor`) so it behaves identically
  whether or not the consumer defaults to MainActor. `@unchecked Sendable` is
  used sparingly and only with a doc comment justifying it — e.g.
  `StatsIdentityStore` is `@unchecked Sendable` because `UserDefaults` is
  documented thread-safe but not marked `Sendable`, and its access is kept
  synchronous on purpose (small scalar reads on the client actor; going
  `async` would only widen the window between capture and disk for no gain).
  `FixedUUIDProvider`, `FixedRandomSource`, and `ManualClock` in
  `StatsTesting` follow the same pattern, backed by `Synchronization.Mutex`.
- **`package`-visible seams vs. `public` API.** Some members exist only for
  this package's own tests and are marked `package`, not `public` — e.g.
  `Duration.statsSeconds` in `StatsTesting` (a testing library has no
  business adding a member to a standard-library type in every consumer's
  namespace) and `StatsConfiguration.contextOverride` (used by `Harness` to
  pin a fixed device/OS context for reproducible encoding assertions, not
  something a real consumer should set). Don't promote a `package` member to
  `public` without a reason a consumer, not just this repo's tests, would
  need it.

## Release process

Practiced in this repo (see `CHANGELOG.md`, which follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) and
[SemVer](https://semver.org/)):

1. Move `[Unreleased]` entries under a new `## [X.Y.Z] — YYYY-MM-DD` heading.
   Call out **wire schema** changes explicitly and separately from package
   changes — the schema in `docs/schema.md` versions independently of the
   package.
2. When a release changes on-disk state, wire behavior, or requires backend
   action, write an "Upgrade notes (read before adopting)" section before the
   `### Added`/`### Fixed` lists — 0.2.0's entry is the template: it calls
   out Swift-package behavior changes, a schema wording change, and a
   required Cloudflare Worker migration (`0003_event_idempotency.sql` via
   `wrangler d1 migrations apply stats --remote`) with a note on what
   pre-migration rollups need re-rolling.
3. Tag `vX.Y.Z` and cut a GitHub release with `gh release create`.
4. If the Cloudflare backend needs a migration or has behavioral changes for
   an operator, write or update the backend's own migration note (see
   `backends/cloudflare/ADOPTION.md`) — the package CHANGELOG links to it
   rather than duplicating operational steps.

## Debugging tips

- **Logs.** The SDK logs under subsystem `com.wizemann.stats` (see
  `StatsLog.subsystem` in `Sources/Stats/Stats.swift`), with categories per
  component — e.g. `"Identity"` for `StatsIdentityStore`. Stream them with:

  ```bash
  log stream --predicate 'subsystem == "com.wizemann.stats"'
  ```

- **Inspecting persisted identity.** The SDK never touches
  `UserDefaults.standard` — the install UUID, `seq`, consent, opt-out flag,
  and hashed `userId` live in a dedicated suite per app id,
  `com.wizemann.stats.<appId>` (`StatsIdentityStore.suiteName(appId:)`).
  Inspect it directly:

  ```bash
  defaults read com.wizemann.stats.<appId>
  ```

  If that suite can't be opened, the store fails closed to
  `com.wizemann.stats.unavailable` and logs an error rather than silently
  falling back to `.standard`.

- **The on-disk queue.** Events wait in `queue.jsonl` (plus the `queue.head`
  consumed-prefix marker) under the client's `storageDirectory`; a test's
  `Harness` puts this at
  `NSTemporaryDirectory()/swift-stats-tests-<appId>/`. `QueueFileTests.swift`
  is the reference for exactly how marker staleness, corruption, and
  degraded-disk fallback are handled if a queue file looks wrong on disk.

## Memory and wiki conventions

This repo's memory (`.memory/`) and wiki (`wiki/`, including this page) are
managed by Memophant. Use the `memophant` MCP tools (`search_memories`,
`write_memory`, `edit_memory`, etc.) for durable facts and long-form docs
rather than hand-editing files or leaving decisions only in chat — the tool
entry points carry guards (slug generation, structure validation, a
write-time secret scan) that a direct file edit skips. Agents do not commit
the managed tiers (`.memory/`, `wiki/`, `design/`, `code/`, `sessions/`,
`documents/`, `vendors/`, `templates/`, `TASKS.md`, `tasks/`) — the user
commits each of those themselves; leave them dirty after an update.

_Last updated: 2026-08-19 — rewritten from source_
