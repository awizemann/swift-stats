# swift-stats

Privacy-first usage analytics for native Apple apps. A small Swift package, zero
dependencies, Swift 6 language mode, and a documented wire schema so the backend
is yours to choose.

> **Status: scaffold + schema (v0.1.0, unreleased).**
> The wire contract in [`docs/schema.md`](docs/schema.md) is complete and stable
> for `v1`. The emitter (`StatsClient` and friends) is **not implemented yet** —
> the code in the quick-start below is the planned API, not shipping API. See
> [Roadmap](#roadmap).

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
  groups (`usage` / `diagnostics` / `identity`) and it persists.
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

## Quick start — **planned API, not yet shipped**

Everything in this section is the design the schema was written against. It does
not compile today. It is here so you can judge the shape — and so the emitter
implementation has a target to hit.

```swift
import Stats
import StatsCloudflare

// 1. Configure once during launch, off the main actor.
let stats = StatsClient(
    configuration: .init(
        appId: "com.example.MyApp",
        projectId: "myapp",
        installIdSalt: "a-constant-per-app-string",   // see schema §9
        autoEvents: [.appOpen, .appBackground],       // opt-in, default none
        sessionInactivityGap: .minutes(5)             // default: 5 on iOS, 30 on macOS
    ),
    sink: CloudflareStatsSink(
        baseURL: URL(string: "https://stats.example.com")!,
        writeKey: writeKey
    )
)

// 2. Nothing is collected until the person says yes. Opt-out is the default.
await stats.setConsent([.usage, .diagnostics])   // .identity withheld → per-session id

// 3. Track. Names are snake_case; props are flat and never carry user text.
await stats.track("project_opened", props: ["section": "analytics", "cached": true])

// 4. Flush on background; the dispatcher also flushes on N events / T seconds.
await stats.flush()

// 5. Forget this install entirely.
await stats.reset()
```

Injection, not a singleton — `StatsClient` is passed in, and a consumer's tests
get a double:

```swift
// Declared `nonisolated protocol` so an actor can conform.
nonisolated protocol UsageTracking: Sendable {
    func track(_ name: String, props: [String: StatsValue]) async
}

// In tests:
let sink = InMemoryStatsSink()          // from StatsTesting
```

## Repo map

```
Package.swift              Products: Stats, StatsCloudflare, StatsTesting
docs/
  schema.md                ★ THE CONTRACT — wire schema v1: ingest + read, identity,
                             sessions, consent, reserved names, never-collected list
backends/
  README.md                How backends plug in + the shared conformance checklist
  cloudflare/              Reserved for the Cloudflare backend (Worker + Analytics Engine)
Sources/
  Stats/                   Core emitter (scaffold today)
    Resources/
      PrivacyInfo.xcprivacy  Bundled manifest: tracking=false, UserDefaults CA92.1
  StatsCloudflare/         HTTP sink + read helper (scaffold today)
  StatsTesting/            In-memory sink, clock/id seams for consumers (scaffold today)
Tests/
  StatsTests/              Includes a test asserting the privacy manifest's contents
  StatsCloudflareTests/
.github/workflows/ci.yml   swift build + swift test on macos-15
CHANGELOG.md               Keep-a-changelog, semver
```

## Roadmap

| Phase | Scope | State |
|---|---|---|
| P12a | Package scaffold, wire schema `v1`, backend contract, CI | **done** |
| P12b | `Stats` core: file-backed queue, dispatcher, identity, sessions, consent, tests | next |
| P12c | `backends/cloudflare/`: ingest Worker + read helper | planned |
| P12d | First consumer emits events | planned |
| P12e | Read side: per-project usage in a consumer app | planned |
| P12f | Tag 0.1.0, semver policy | planned |

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
