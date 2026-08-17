# swift-stats

Privacy-first usage analytics for native Apple apps. A small Swift package, zero
dependencies, Swift 6 language mode, and a documented wire schema so the backend
is yours to choose.

> **Status: core client + schema (v0.1.0).**
> The wire contract in [`docs/schema.md`](docs/schema.md) is complete and stable
> for `v1`, and the emitter (`StatsClient`, the file-backed queue, the
> dispatcher, identity, sessions, consent) is implemented and tested. A shipping
> backend is included: [`backends/cloudflare/`](backends/cloudflare/README.md)
> (Worker + D1) with the matching `StatsCloudflare` adapter. See [Roadmap](#roadmap).

## Why

Every Apple-platform analytics SDK asks you to choose between "learn nothing
about your app" and "ship someone else's tracking SDK". swift-stats is the third
option: you learn which features people actually use, and you can say honestly
that you do not track anyone — because the package cannot.

It is also, as far as we can tell, the only small Apple analytics SDK that is
actor-based, written for Swift 6 language mode, and pluggable at the backend.

## Principles

- **Privacy-first, structurally.** A random UUID hashed with your salt is the
  only identifier. No IDFV, no IDFA, no Keychain, no device serial, no IP
  storage, no location, no free text, no session replay. The list of things the
  schema forbids is written down and normative:
  [schema §13](docs/schema.md#13-deliberately-never-collected).
- **Opt-out by default, per app.** With no configuration the SDK collects
  nothing at all — no queue, no id, no context. Consent is three independent
  groups (`usage` / `diagnostics` / `identity`) and it persists. A leaked write
  key can only append to the one project it was minted for — the backend derives
  the project from the key, never from the client.
- **Not tracking.** `NSPrivacyTracking` is `false` and there are no tracking
  domains, because first-party data with a non-correlatable id is not tracking.
  No ATT prompt. The bundled `PrivacyInfo.xcprivacy` says exactly that, and a
  test asserts it.
- **Zero dependencies.** Foundation and `os` only. No swift-log, no
  OpenTelemetry — nothing to audit but this package.
- **Pluggable backends.** The load-bearing artifact is the schema, not the SDK.
  Anything that speaks `POST /v1/events` is a valid backend — see
  [`backends/`](backends/README.md).
- **Swift 6 native.** Language mode 6, actors for the queue and dispatcher,
  `nonisolated protocol` for every seam so an actor can conform, `Sendable`
  value types across every boundary, and no `.defaultIsolation(MainActor.self)`
  in the library — swift-stats behaves the same whether or not *your* module
  defaults to MainActor.
- **Deterministic tests.** Swift Testing only, injectable clock and id seams,
  and no test in this repo sleeps.

## Requirements

| | |
|---|---|
| Platforms | macOS 15+, iOS 18+ |
| Swift | 6.2 toolchain or newer, language mode 6 |
| Dependencies | none |

## Installation

```swift
.package(url: "https://github.com/awizemann/swift-stats.git", from: "0.1.0")
```

```swift
.target(name: "MyApp", dependencies: [
    .product(name: "Stats", package: "swift-stats"),
    .product(name: "StatsCloudflare", package: "swift-stats")  // optional backend adapter
])
```

## Quick start

```swift
import Stats

// 1. Configure once during launch. The sink is yours; see "Writing a sink".
let stats = StatsClient(configuration: StatsConfiguration(
    appId: "com.example.MyApp",
    projectId: "myapp",                          // advisory: the write key is authoritative (schema §2.4)
    installIdSalt: "a-constant-per-app-string",  // schema §9 — not a secret
    sink: MyHTTPSink(baseURL: url, writeKey: writeKey),
    flushAt: 20,                                 // flush at N queued events
    flushInterval: .seconds(30),                 // …or T since the last flush
    autoEvents: [.appOpen, .appBackground, .sessions]  // opt-in, default none
    // sessionGap defaults to 30 min on macOS, 5 min on iOS
))

// 2. Nothing is collected until the person says yes: the SDK's default is `[]`.
await stats.setConsent([.usage, .diagnostics])   // .identity withheld → per-session id

// 3. Track. Names are snake_case; props are flat and never carry user text.
await stats.track("project_opened", props: ["section": "analytics", "cached": true])

// 4. Drive sessions and the background flush from your scene phase — the SDK
//    installs no AppKit/UIKit observers of its own (see "Consumer checklist").
await stats.applicationDidBecomeActive()
await stats.applicationDidEnterBackground()

// 5. Flush on demand, opt out, forget the install entirely.
await stats.flush()
await stats.setEnabled(false)    // no capture, queue cleared, remembered
await stats.reset()              // new install id, seq back to 0, new session
```

`track()` returns once the event is **on disk**, not once it is sent — a queued
event survives a kill. `identify(userID:)` is opt-in, hashed with your salt
before it leaves the device, and most apps should never call it.

### Writing a sink

```swift
// `nonisolated protocol`, so an actor can conform. Sinks never throw: every
// transport error becomes an outcome, because the retry decision is normative.
public nonisolated protocol StatsSink: Sendable {
    // SinkOutcome: .accepted / .retry(after:) / .tooLarge / .drop(reason:)
    func send(_ batch: StatsBatch) async -> SinkOutcome
}
```

Map the HTTP responses exactly as [schema §7](docs/schema.md#7-ingest-contract--post-v1events)
prescribes: `202 → .accepted`; `429 → .retry(after: Retry-After)`; `5xx`,
timeouts and offline → `.retry(after: nil)`; `413 → .tooLarge`; `400`, `401`, any
other 4xx and any 3xx → `.drop(reason:)`. The dispatcher handles the rest: one
request in flight, batches of ≤ 100 events and ≤ 256 KiB (split by bytes before
count), exponential backoff from 1 s with full jitter capped at 5 minutes, no
sending at all inside a backoff window, a re-split with fresh batch ids on
`.tooLarge`, a 24-hour ceiling on delivery attempts for one batch, and the same
`batchId` across retries of the same batch so a backend's dedupe works.

### Injection, not a singleton

```swift
nonisolated protocol UsageTracking: Sendable {          // an actor can conform
    func track(_ name: String, props: [String: StatsValue]) async
}

// In tests, `import StatsTesting` for a recording sink, a clock you drive by
// hand, and deterministic ids. No test needs to sleep.
let sink = InMemorySink(outcomes: [.retry(after: nil), .accepted])
let clock = ManualClock()
let client = StatsClient(configuration: StatsConfiguration(
    appId: "com.example.Tests", installIdSalt: "s", sink: sink,
    clock: clock, uuidProvider: FixedUUIDProvider(), randomSource: FixedRandomSource()
))
await client.track("thing_happened")
await client.flush()
clock.advance(by: .seconds(30))     // drives the interval flush and the backoff
```

## Cloudflare backend

[`backends/cloudflare/`](backends/cloudflare/README.md) is a complete,
conformance-checked backend: a Worker on **D1** serving `POST /v1/events`,
`GET /v1/summary` and `GET /v1/events/top`, plus a nightly Cron Trigger that
rolls up closed days and deletes raw events past 90 days. Distinct counts are
exact. Keys are stored only as SHA-256 hashes, and `projectId` is derived from
the write key's scope. Deploying it is `npx wrangler login && npm run deploy`.

You can self-host it on your own Cloudflare account, or use the hosted
instance at **`https://api.swiftstats.co`** (same Worker, same contract, keys
issued per project). Hosted sign-up is not open yet; self-hosting is fully
supported today.

The matching Swift adapter is the `StatsCloudflare` product: `CloudflareSink`
for emitting, and `StatsQuery` for reading a project's own numbers back into an
app.

```swift
import StatsCloudflare

let query = StatsQuery(
    endpoint: try CloudflareEndpoint(string: "https://stats.example.com"),
    readKey: readKey                     // NOT embeddable in a shipped app — schema §8
)

let summary = try await query.summary(
    projectId: "myapp",
    from: StatsDay("2026-08-01")!,
    to: StatsDay(utcDayOf: .now)
)
for row in summary.rows {
    print(row.date, row.opens, row.sessions, row.activeInstalls, row.events)
}
```

`CloudflareSink` is the `StatsSink` for it — HTTPS-only, no cookies, redirects
refused, uncompressed, and mapping every §7 status onto the right `SinkOutcome`:

```swift
let stats = StatsClient(configuration: StatsConfiguration(
    appId: "com.example.MyApp",
    installIdSalt: "a-constant-per-app-string",
    sink: CloudflareSink(
        endpoint: try CloudflareEndpoint(string: "https://stats.example.com"),
        writeKey: writeKey          // ships in the binary; append-only, one project
    )
))
```

## Consumer checklist

Five things the SDK cannot do for you:

1. **Call the two lifecycle methods.** `applicationDidBecomeActive()` and
   `applicationDidEnterBackground()`, typically from `scenePhase`. swift-stats
   installs **no** AppKit/UIKit observers in v1 — a library that silently hooks
   your app lifecycle is not auditable, and an observer would drag a UI framework
   and main-actor delivery into a Foundation-only package. Skip them and you lose
   `app_open` / `app_background` and the flush-on-background; nothing else.

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

2. **Declare what you collect.** The package ships its own
   `PrivacyInfo.xcprivacy`, but *your app* must declare **Product Interaction**
   and **Other Diagnostic Data** (neither linked to identity, neither used for
   tracking) in its manifest and nutrition label — and additionally **User ID**
   if, and only if, you call `identify(userID:)`
   ([schema §14](docs/schema.md#14-privacy-manifest)).

3. **Choose a salt and never change it.** Any constant string, committed with the
   app. It is not a secret and grants nothing; its only job is to stop the same
   random UUID from being correlatable across apps or backends. Changing it
   silently re-identifies every install as new.

4. **Ship an opt-out control.** `setEnabled(false)` for the master switch and
   `setConsent(_:)` for the three groups; both persist. Remember that revoking a
   group *discards* the queue and deletes the stored install id — that is the
   point. Put the toggle somewhere a person can find it.

5. **Pass in the two things the core cannot sample.** `screenMetrics` and
   `colorScheme` need AppKit/UIKit, and `isPreRelease` (the context's
   `isTestFlight`) now needs StoreKit — none of which belongs in a
   Foundation-only package. Read them where you already are on the main actor and
   hand them to the configuration; the defaults are the schema's legal
   stand-ins (`0` / `0` / `1.0`, omitted, `false`).

## Repo map

```
Package.swift              Products: Stats, StatsCloudflare, StatsTesting
docs/
  schema.md                ★ THE CONTRACT — wire schema v1: ingest + read, identity,
                             sessions, consent, reserved names, never-collected list
backends/
  README.md                How backends plug in + the shared conformance checklist
  cloudflare/              Cloudflare backend: Worker + D1, migrations, admin CLI,
                             conformance suite (npm test)
Sources/
  Stats/                   Core emitter: value types, client, queue, dispatcher
    StatsClient.swift        The actor: track / identify / consent / flush / reset / lifecycle
    Dispatcher.swift         Flush triggers, batching, backoff, drop-vs-retain
    EventStore.swift         JSON-lines durable queue in Application Support
    StatsIdentityStore.swift Own UserDefaults suite: install UUID, seq, consent
    StatsEnvironment.swift   Context sampling (Bundle/ProcessInfo/uname/Locale only)
    Resources/
      PrivacyInfo.xcprivacy  Bundled manifest: tracking=false, UserDefaults CA92.1
  StatsCloudflare/         CloudflareSink (ingest) + StatsQuery (reads)
    IngestDisposition.swift  §7's status-to-behavior table as a pure function
  StatsTesting/            InMemorySink, ManualClock, fixed uuid/random providers
Tests/
  StatsTests/              Encoding, props, identity, sessions, consent, dispatch
                             — plus a test asserting the privacy manifest's contents
  StatsCloudflareTests/
.github/workflows/ci.yml   swift build + swift test on macos-15, plus the
                             backend's vitest conformance suite
CHANGELOG.md               Keep-a-changelog, semver
```

## Roadmap

| Phase | Scope | State |
|---|---|---|
| P12a | Package scaffold, wire schema `v1`, backend contract, CI | **done** |
| P12b | `Stats` core: file-backed queue, dispatcher, identity, sessions, consent, tests | **done** |
| P12c | `backends/cloudflare/`: ingest Worker on D1 + read helper | **done** |
| P12d | First consumer emits events | planned |
| P12e | Read side: per-project usage in a consumer app | planned |
| P12f | Tag 0.1.0, semver policy | **done** |

Until 1.0, minor versions may make breaking API changes. The **wire schema** is
versioned separately, and `v1` will not break — see
[schema §15](docs/schema.md#15-versioning-this-document).

## Contributing

Issues and PRs welcome. Two rules that save everyone time:

1. **The schema comes first.** If a change affects the wire format, change
   `docs/schema.md` in the same PR — and if it is a breaking change, it needs a
   `v2`, not an edit to `v1`.
2. **No new dependencies** in `Stats`, and nothing that adds a required-reason
   API beyond `UserDefaults`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Alan Wizemann.
