---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: README.md, CHANGELOG.md, docs/schema.md, Sources/Stats/StatsConfiguration.swift, Sources/Stats/StatsClient.swift, Sources/Stats/StatsConsent.swift, Sources/Stats/StatsSink.swift, Sources/StatsTesting/InMemorySink.swift, Sources/StatsTesting/ManualClock.swift, Sources/StatsTesting/FixedProviders.swift, Sources/StatsCloudflare/StatsTransport.swift, .github/workflows/ci.yml
source_paths_inferred: false
---

# Getting Started

swift-stats is a privacy-first usage-analytics package for native Apple apps:
zero dependencies, Swift 6 language mode, and a documented wire schema
(`docs/schema.md`) so the backend is yours to choose.

Requirements: macOS 15+ / iOS 18+, a Swift 6.2 toolchain or newer, language
mode 6.

## Installation

```swift
.package(url: "https://github.com/awizemann/swift-stats.git", from: "0.2.0")
```

```swift
.target(name: "MyApp", dependencies: [
    .product(name: "Stats", package: "swift-stats"),
    .product(name: "StatsCloudflare", package: "swift-stats")  // optional backend adapter
])
```

Three products: `Stats` (the emitter), `StatsCloudflare` (the shipped backend
adapter — see [Cloudflare Backend](Cloudflare-Backend)), and `StatsTesting`
(test seams, for your test target only).

## Quick start

This is the same code as the README's quick start; keep the two in sync.

```swift
import Stats
import StatsCloudflare

// 1. Configure once during launch. Constructing a client is cheap and does no
//    disk I/O, so this is safe directly in `App.init` or on the main actor — no
//    `Task.detached` wrapper needed. The sink is yours; `CloudflareSink` is the
//    one shipped in this repo, and "Writing a sink" covers rolling your own.
//
//    `CloudflareEndpoint` validates the URL (HTTPS only), so it throws — hence a
//    function rather than a top-level `let`.
func makeStats(writeKey: String) throws -> StatsClient {
    StatsClient(configuration: StatsConfiguration(
        appId: "com.example.MyApp",
        projectId: "myapp",                          // advisory: the write key is authoritative (schema §2.4)
        installIdSalt: "a-constant-per-app-string",  // schema §9 — not a secret
        sink: CloudflareSink(
            endpoint: try CloudflareEndpoint(string: "https://stats.example.com"),
            writeKey: writeKey                       // ships in the binary; append-only, one project
        ),
        flushAt: 20,                                 // flush at N queued events
        flushInterval: .seconds(30),                 // …or T since the last flush
        autoEvents: [.appOpen, .appBackground, .sessions]  // opt-in, default none
        // consent defaults to [.usage, .diagnostics]
        // sessionGap defaults to 30 min on macOS, 5 min on iOS
    ))
}

let stats = try makeStats(writeKey: writeKey)

// 2. Consent already defaults to [.usage, .diagnostics], so this line is only
//    needed to CHANGE it — to grant .identity (a stable install id + userId), or
//    to pass .none if your policy wants collect-nothing-until-asked.
await stats.setConsent([.usage, .diagnostics])   // .identity withheld → per-session id

// 3. Record. Names are snake_case; props are flat and never carry user text.
//    `record()` is not async: it never suspends the caller, so it is safe in a
//    button action or a view body with no Task wrapper at all.
stats.record("project_opened", props: ["section": "analytics", "cached": true])

//    Use `await track()` when you need the event to be ON DISK before you
//    continue — the same call, minus the fire-and-forget.
await stats.track("checkout_completed")

// 4. Drive sessions and the background flush from your scene phase — the SDK
//    installs no AppKit/UIKit observers of its own (see "Consumer checklist").
await stats.applicationDidBecomeActive()
await stats.applicationDidEnterBackground()

// 5. Flush on demand, opt out, forget the install entirely.
await stats.flush()
await stats.setEnabled(false)    // no capture, queue cleared, remembered
await stats.reset()              // new install id, seq back to 0, new session
```

## Configuration reference

Every parameter of `StatsConfiguration.init`, with its real default
(`Sources/Stats/StatsConfiguration.swift`).

| Parameter | Default | What it does |
|---|---|---|
| `appId` | required | The bundle identifier. Goes on the wire as each event's `appId`, and derives both the `UserDefaults` suite name and the queue file path. |
| `projectId` | `nil` | Advisory tenant key (§2.4); the backend derives the authoritative value from the write key's scope. A malformed value (not 1–64 of `[A-Za-z0-9._-]`) is logged and dropped rather than sent. |
| `installIdSalt` | required | Per-app constant salting the install-id hash (§9). Not a secret. |
| `sink` | required | The transport (`any StatsSink`). Sinks never throw. |
| `flushAt` | `20` | Flush when this many events are queued. Clamped to `max(1, flushAt)`. |
| `flushInterval` | `.seconds(30)` | Flush when this much time has passed since the last flush and at least one event is queued. |
| `maxQueued` | `10_000` | Local queue cap; past it the **oldest** events are dropped (§5). Clamped to `max(1, maxQueued)`. |
| `sessionGap` | `StatsConfiguration.defaultSessionGap` — 30 min on macOS, 5 min everywhere else | Inactivity gap that starts a new session (§10), measured on the monotonic clock. |
| `enabled` | `true` | Master opt-out. `false` means no capture at all and a cleared queue. The persisted choice wins after first run. |
| `consent` | `.default` = `[.usage, .diagnostics]` | Initial consent, used only the first time the app runs; afterwards the persisted choice wins (§11). |
| `autoEvents` | `.none` | Which reserved auto-events to emit: `.appOpen`, `.appBackground`, `.sessions` (§12). |
| `storageDirectory` | `nil` → `Application Support/<appId>/swift-stats/` | Directory for `queue.jsonl`. A directory you supply is created if missing and otherwise left exactly as your app set it. |
| `screenMetrics` | `.headless` | Screen width/height/scale; the core never imports AppKit/UIKit. |
| `colorScheme` | `nil` | `"light"` / `"dark"` if you sample it; omitted from the wire when `nil`. |
| `isPreRelease` | `nil` | The context's `isTestFlight`. `nil` sends `false`. |
| `retentionCeiling` | `.seconds(24 * 60 * 60)` | Longest a batch may be retained before it is dropped and logged at `error` (§7). |
| `backoffCap` | `.seconds(5 * 60)` | Backoff cap per attempt (§7). |
| `backoffBase` | `.seconds(1)` | Backoff base — doubling, full jitter (§7). |
| `clock` | `SystemStatsClock()` | Wall clock, monotonic clock and `sleep(for:)` seam. |
| `uuidProvider` | `SystemUUIDProvider()` | Install identity and `batchId`. |
| `randomSource` | `SystemRandomSource()` | Session-id digits and the backoff jitter fraction. |

## `record()` or `track()`?

Both validate the name, sanitize the props, respect consent and the opt-out, and
preserve call order — including relative to each other, from the same caller.
They differ in one thing, durability:

- **`record(_:props:)`** is `nonisolated` and non-`async`. It hands the event to
  the actor through a lock-protected buffer and returns immediately: no
  suspension, no actor hop, no `Task { }` at the call site, and the timestamp is
  taken at the call rather than whenever the actor gets to it. The buffer is
  capped at 10 000 in-flight entries; past that the **newest** are dropped and a
  rate-limited error is logged. **Use this by default.**
- **`await track(_:props:)`** returns once the event is **on disk**, not once it
  is sent — a queued event survives a kill. Use it right before a deliberate
  teardown or an operation that may end the process.

`flush()`, `waitForFlushes()`, `shutdown()`, `reset()`, `identify(userID:)` and
both lifecycle methods drain whatever `record()` has accepted before they do
their own work; a test that wants only the drain can `await stats.drainRecorded()`.

Event names must match `^[a-z][a-z0-9_]*$`, 1–64 scalars, and must not be one of
the reserved names (§2.1, §12). A refused name is dropped and logged at `error`.

`identify(userID:)` is opt-in, hashed with your salt before it leaves the device,
and most apps should never call it. It is ignored while the client is opted out,
and its value is never emitted while `identity` consent is denied.

## Consent groups — what they really cover

Three independent groups (`Sources/Stats/StatsConsent.swift`, schema §11):

| Group | Covers | Denied means |
|---|---|---|
| `usage` | Event names, `props`, sessions, auto-events (§12). | Nothing is emitted at all, whatever the other groups say. |
| `diagnostics` | The **context object's** device/OS fields: `osName`, `osVersion`, `deviceModel`, `arch`, screen metrics, `locale`, `region`, `isDebug`, `isTestFlight`, `colorScheme`. | A well-formed `context` is still sent (the field is required) with the documented unknown values: `osVersion` major only, `deviceModel` `"unknown"`, `locale` language only, `region` `"ZZ"`, screen `0`/`0`/`1.0`, `colorScheme` omitted. |
| `identity` | A stable `installId` across launches, and the `userId` field (§2.5). | A fresh ephemeral install id per session, and `userId` omitted even if `identify()` was called. |

`diagnostics` is **not** crash/error/performance reporting — swift-stats collects
no crashes, no stack traces and no performance timings. It governs the context
fields listed above and nothing else.

Defaults: `.default` is `[.usage, .diagnostics]`. `.identity` is deliberately not
in it, because a stable install id and a `userId` change what your app must
disclose (§14). `.none` collects nothing at all — no queue, no install id, no
context.

### The opt-out / revoke / reset asymmetry

| Call | Queue | Hashed `userId` | Persisted install UUID |
|---|---|---|---|
| `setEnabled(false)` | discarded | forgotten | **kept** |
| `setConsent(_:)` revoking a group | discarded | forgotten | **deleted** |
| `reset()` | flushed first | forgotten | regenerated (or deleted when `identity` is denied) |

The opt-out is a *switch*: someone who turns it off and back on expects the same
install, and nothing is collected while it is off, so the retained UUID sits
unused. A consent revocation is a *withdrawal of permission to identify*, which
§11 requires be unresumable, so the UUID is deleted and `seq` goes back to 0. For
"stop collecting **and** forget me", call `reset()` after the opt-out.

## Lifecycle hooks

```swift
.onChange(of: scenePhase) { _, phase in
    Task {
        switch phase {
        case .active:     await stats.applicationDidBecomeActive()
        case .background: await stats.applicationDidEnterBackground()
        default: break
        }
    }
}
```

- `applicationDidBecomeActive()` starts a session if none is current or the
  inactivity gap elapsed, and emits `app_open` at most once per session when that
  auto-event is enabled.
- `applicationDidEnterBackground()` emits `app_background` when enabled, then
  flushes.
- `shutdown()` cancels the interval timer and any pending retry, leaving queued
  events on disk for the next launch.

The SDK installs **no** AppKit/UIKit observers. Skip these calls and you lose
`app_open` / `app_background` and the flush-on-background; nothing else.

## Consumer checklist

Five things the SDK cannot do for you — and one thing you do *not* have to do:
`StatsClient(configuration:)` performs no disk I/O. No directory is created, no
`UserDefaults` suite is opened, no queue file is read; all of that happens lazily
inside the actor on the first `record()`, `track()` or
`applicationDidBecomeActive()`.

1. **Call the two lifecycle methods** (above).
2. **Declare what you collect.** The package ships its own `PrivacyInfo.xcprivacy`
   (tracking `false`, Product Interaction + Other Diagnostic Data, `UserDefaults`
   reason CA92.1), but *your app* must declare Product Interaction and Other
   Diagnostic Data in its manifest and nutrition label — plus **User ID** if and
   only if you call `identify(userID:)` (§14).
3. **Choose a salt and never change it.** Any constant string committed with the
   app. Changing it silently re-identifies every install as new.
4. **Ship an opt-out control** — `setEnabled(false)` plus `setConsent(_:)`; both
   persist.
5. **Pass in what the core cannot sample:** `screenMetrics`, `colorScheme` and
   `isPreRelease`. Defaults are the schema's legal stand-ins (`0`/`0`/`1.0`,
   omitted, `false`).

## iOS notes

- **Queue location and backups.** The queue lives at
  `Application Support/<appId>/swift-stats/queue.jsonl` with a `queue.head`
  sidecar. A directory the SDK creates for itself is made `0700` and marked
  `isExcludedFromBackup` (best effort, once per process); every file the package
  writes is `0600` after each write. A `storageDirectory` you supply gets neither
  the mode change nor the backup exclusion.
- **Low Data Mode (0.2.0 behaviour change).** The default `URLSessionTransport`
  sets `allowsConstrainedNetworkAccess = false`, so under Low Data Mode nothing
  is sent — batches stay queued (with drop-oldest past `maxQueued`) until the
  mode lifts. Pass `allowsConstrainedNetworkAccess: true` to
  `URLSessionTransport.init` or `defaultConfiguration()` to keep sending.
  `allowsExpensiveNetworkAccess` defaults to `true`.
- **Timeouts (0.2.0 behaviour change).** 20 s per request, 60 s per resource
  (previously the `URLSession` defaults). The session is ephemeral, refuses
  cookies, and uses `networkServiceType = .background`.
- **Flush on background** is whatever `applicationDidEnterBackground()` manages
  before the process is suspended; there is no background-task hook in 0.2.0.

## Testing your integration

`import StatsTesting` in your test target for a recording sink, a hand-driven
clock, and deterministic ids. No test needs to sleep.

```swift
import StatsTesting

let sink = InMemorySink(outcomes: [.retry(after: nil), .accepted])  // defaultOutcome: .accepted
let clock = ManualClock()
let client = StatsClient(configuration: StatsConfiguration(
    appId: "com.example.Tests", installIdSalt: "s", sink: sink,
    clock: clock, uuidProvider: FixedUUIDProvider(), randomSource: FixedRandomSource()
))
await client.track("thing_happened")
await client.flush()
clock.advance(by: .seconds(30))     // drives the interval flush and the backoff
```

- `InMemorySink` — an `actor`. `init(outcomes: [SinkOutcome] = [], defaultOutcome: SinkOutcome = .accepted)`;
  scripted outcomes are consumed front to back, then `defaultOutcome` applies.
  Inspect `batches`, `sentEvents`, `sentEventNames`, `batchCount`; mutate with
  `setOutcomes(_:defaultOutcome:)` and `reset()`. Repeat attempts of a retried
  batch appear too, so you can assert that a retry reused its `batchId`.
- `ManualClock` — `init(wallStart: Date = Date(timeIntervalSince1970: 1_786_012_978))`.
  Conforms to both `StatsClock` and `Clock`. Drive it with `advance(by:)`; inspect
  `requestedSleeps` to assert a backoff schedule, `pendingSleepCount`, and use
  `await waitForSleepers(count:)` before advancing so you cannot pass a deadline
  that has not been set. Call `cancelAllSleepers()` in teardown.
- `FixedUUIDProvider` — `init(_ uuids: [UUID] = [], fallback: UUID = UUID(uuidString: "00000000-0000-4000-8000-000000000000")!)`;
  hands out `uuids` in order, then the fallback. `issued` lists everything given out.
- `FixedRandomSource` — `init(firstDigits: Int = 40_371_852, fraction: Double = 1.0)`.
  The digit run advances by one per call (so two sessions in the same second are
  distinguishable), and `fraction` is the jitter multiplier — `1.0` makes the
  full-jitter backoff equal its unjittered ceiling, i.e. `1, 2, 4, 8…` seconds.

Also useful: `await client.drainRecorded()` to wait for everything `record()`
accepted, and `await client.queuedEventCount` for the current queue depth.

### Building and testing this repo

```bash
swift build
swift test
```

The iOS build in CI (`.github/workflows/ci.yml`) — this compiles the
`#if os(iOS)` branches, which `swift test` on macOS cannot reach:

```bash
xcodebuild \
  -scheme swift-stats-Package \
  -destination 'generic/platform=iOS Simulator' \
  build
```

`swift-stats-Package` is the aggregate scheme SwiftPM generates; one invocation
builds `Stats`, `StatsCloudflare` and `StatsTesting`.

## Where to go next

- [Architecture](Architecture) — the actors, the event path, the queue, the
  dispatcher, the seams.
- [Cloudflare Backend](Cloudflare-Backend) — the Worker + D1 backend and the
  `StatsCloudflare` adapter.
- [Wire Schema Reference](Wire-Schema-Reference) — the normative contract.
- [Contributing & Testing](Contributing-&-Testing) — how to work on the package.

_Last updated: 2026-08-19 — rewritten from source_
