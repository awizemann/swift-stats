# swift-stats

Privacy-first usage analytics for native Apple apps. A small Swift package, zero
dependencies, Swift 6 language mode, and a documented wire schema so the backend
is yours to choose.

> **Status: core client + schema (v0.2.0).**
> The wire contract in [`docs/schema.md`](docs/schema.md) is complete and stable
> for `v1`, and the emitter (`StatsClient`, the file-backed queue, the
> dispatcher, identity, sessions, consent) is implemented and tested. A shipping
> backend is included: [`backends/cloudflare/`](backends/cloudflare/README.md)
> (Worker + D1) with the matching `StatsCloudflare` adapter. See
> [Status and roadmap](#status-and-roadmap).

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
- **Opt-out by default, per app.** With no configuration the SDK collects usage
  and diagnostics — `consent` defaults to `[.usage, .diagnostics]` — and the
  opt-out you ship for a person is `setEnabled(false)`. `identity` is **not** in
  the default and has to be asked for in code, because a stable install id and a
  `userId` change what your app must disclose
  ([schema §14](docs/schema.md#14-privacy-manifest)). If your policy or
  jurisdiction wants collect-nothing-until-asked, pass `consent: .none`: with
  `.none` recorded there is no queue, no id and no context. Consent is three
  independent groups (`usage` / `diagnostics` / `identity`) and it persists. A
  leaked write key can only append to the one project it was minted for — the
  backend derives the project from the key, never from the client.
- **Not tracking.** `NSPrivacyTracking` is `false` and there are no tracking
  domains, because first-party data with a non-correlatable id is not tracking.
  No ATT prompt. The bundled `PrivacyInfo.xcprivacy` says exactly that, and a
  test asserts it.
- **Zero dependencies.** System frameworks only — Foundation, `os`,
  CryptoKit (the install-id hash) and Synchronization (the `record()` buffer).
  No swift-log, no OpenTelemetry — nothing to audit but this package.
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
.package(url: "https://github.com/awizemann/swift-stats.git", from: "0.2.0")
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

### `record()` or `track()`?

Both validate the name, sanitize the props, respect consent and the opt-out, and
preserve call order — including relative to each other, from the same caller.
They differ in one thing, durability:

- **`record(_:props:)`** is `nonisolated` and non-`async`. It hands the event to
  the actor through a lock-protected buffer and returns immediately: no
  suspension, no actor hop, no `Task { }` at the call site, and the timestamp is
  taken at the call rather than whenever the actor gets to it. The buffer is
  capped at 10 000 in-flight entries; past that the newest are dropped and a
  rate-limited error is logged. **Use this by default.**
- **`await track(_:props:)`** returns once the event is **on disk**, not once it
  is sent — a queued event survives a kill. Use it when you specifically need
  that guarantee, most often right before a deliberate teardown or an operation
  that may end the process.

`flush()`, `waitForFlushes()`, `shutdown()`, `reset()`, `identify(userID:)` and
both lifecycle methods drain whatever `record()` has accepted before they do
their own work, so nothing recorded is left behind or mis-attributed; a test
that wants only the drain can `await stats.drainRecorded()`.

`identify(userID:)` is opt-in, hashed with your salt before it leaves the
device, and most apps should never call it.

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
    func record(_ name: String, props: [String: StatsValue])
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
exact, ingest is idempotent per batch *and* per event, keys are stored only as
SHA-256 hashes, and `projectId` is derived from the write key's scope.
Deploying it is `npx wrangler login && npm run deploy`; upgrading an existing
deployment to 0.2.0 requires applying migration `0003` (see
[`ADOPTION.md`](backends/cloudflare/ADOPTION.md)).

You can self-host it on your own Cloudflare account, or — eventually — use the
hosted instance at **`https://api.swiftstats.co`**. It runs the same Worker from
this repo against the same wire contract, with the same retention: **raw event
rows for 90 days, daily rollups kept indefinitely** (so per-day history survives,
while the individual events behind it do not — [schema
§13](docs/schema.md#13-deliberately-never-collected)). Keys are **issued per
project by the operator**; there is no self-serve key minting, and a write key is
scoped to exactly one project.

**Hosted sign-up is not open yet.** There is no way to get a hosted key today —
self-hosting is the supported path, and it is the whole backend, not a reduced
one.

The matching Swift adapter is the `StatsCloudflare` product: `CloudflareSink`
for emitting, and `StatsQuery` for reading a project's own numbers back into an
app.

```swift
import StatsCloudflare

// `CloudflareEndpoint` and `summary` both throw, so this lives in a function
// rather than at file scope.
func printLastMonth(readKey: String) async throws {
    let query = StatsQuery(
        endpoint: try CloudflareEndpoint(string: "https://stats.example.com"),
        readKey: readKey                 // NOT embeddable in a shipped app — schema §8
    )

    let summary = try await query.summary(
        projectId: "myapp",
        from: StatsDay(utcDayOf: .now.addingTimeInterval(-29 * 86_400)),
        to: StatsDay(utcDayOf: .now)
    )
    for row in summary.rows {
        print(row.date, row.opens, row.sessions, row.activeInstalls, row.events)
    }
}
```

`CloudflareSink` is the `StatsSink` for it — HTTPS-only, no cookies, redirects
refused, uncompressed, and mapping every §7 status onto the right `SinkOutcome`.
See the quick start above for how it is wired into a `StatsConfiguration`.

## Storage & networking

**Queue location.** The durable queue lives at
`Application Support/<bundleId>/swift-stats/queue.jsonl`, with a small sidecar
marker (`queue.head`) beside it. `Caches` is deliberately not used — the system
may evict a cache at any moment, and a dropped queue is data loss.

**The `queue.head` marker.** It holds one number: how many leading *bytes* of
`queue.jsonl` are already consumed (plus the file's size when the marker was
written, as a staleness tag). Removing a batch moves that offset instead of
rewriting the queue file, and the file is only rewritten once the dead prefix
has grown to the size of the live remainder. Because an append only ever grows
the file and never moves a byte before the offset, **appending writes no marker
at all** — `track()` costs one `write(2)` and nothing else. A marker that
cannot be parsed, points past the end of the file, does not land on a line
boundary, or is tagged with a size the file never reached is ignored and the
queue is read from byte zero: the worst case is re-sending a batch that was
already accepted, never skipping events that were not. The bundled Cloudflare
backend absorbs such a re-send — it stores at most one event per
`(projectId, installId, seq)` ([schema §6](docs/schema.md#6-idempotency)) — so
a crash-time replay does not double-count.

**Excluded from backups.** The `swift-stats` directory is marked
`isExcludedFromBackup` (via `URLResourceValues`) the first time it is created
or confirmed each process launch. Everything in the queue is disposable
analytics — including a hashed `userId` for an install that has not yet
flushed — and Apple's own guidance is that regenerable or purely transient
data should not ride along in an iCloud/iTunes backup. Best-effort: a
filesystem that cannot express the flag logs an error and the write proceeds
unaffected. This applies only to a directory the SDK created for itself (the
default path above, or its temporary-directory fallback). If you pass your own
`storageDirectory`, it is created if missing and otherwise left exactly as your
app set it — no mode change, no backup exclusion.

**Permissions.** A `swift-stats` directory the SDK creates for itself is
created `0700`, and every file this package writes (`queue.jsonl`,
`queue.head`) is restricted to `0600` after each write — in your own
`storageDirectory` too — atomic writes replace the file and would otherwise
pick up the process umask. The queue holds event names, `props`, and a hashed
`userId`, not a secret, but on macOS another user's process can read a `0644`
file under `~/Library/Application Support`.

**Networking (`URLSessionTransport`).** The default session, built by
`URLSessionTransport.defaultConfiguration()`, is ephemeral (no on-disk cache,
no cookies — schema §7) with:

- `timeoutIntervalForRequest = 20` — the dispatcher holds one flush slot at a
  time (schema §5); a stalled connection must give it back before it starves
  every later batch.
- `timeoutIntervalForResource = 60` — bounds the whole exchange even when the
  connection keeps making slow forward progress.
- `networkServiceType = .background` — analytics never competes with the host
  app's own traffic for bandwidth or a radio wake-up.
- `allowsConstrainedNetworkAccess = false` — a batch is not sent at all under
  Low Data Mode; `URLSession` surfaces that as a `URLError`, which the
  transport already treats as a transport failure and `IngestDisposition`
  already maps to "retain and retry later," so the batch stays queued rather
  than silently never leaving.

`allowsConstrainedNetworkAccess` and `allowsExpensiveNetworkAccess` are
parameters on both `URLSessionTransport.defaultConfiguration(...)` and
`URLSessionTransport.init(...)`, so you can opt in to sending under Low Data
Mode (or opt out of an expensive/cellular link) without hand-building a
`URLSessionConfiguration`; a consumer supplying its own `URLSession` can start
from `defaultConfiguration()` rather than duplicating these values.

## Consumer checklist

Five things the SDK cannot do for you. One thing you do **not** have to do:
`StatsClient(configuration:)` performs no disk I/O — no directory is created, no
`UserDefaults` suite is opened, no queue file is read. The path is resolved and
the suite opened lazily inside the actor on the first `record()`, `track()` or
`applicationDidBecomeActive()`. Construct it wherever is convenient, including
`App.init` on the main actor, with no `Task.detached` around it.

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
   `setConsent(_:)` for the three groups; both persist. Put the toggle somewhere
   a person can find it.

   The two are **deliberately asymmetric about the install id**, and it is worth
   knowing which you are calling:

   | Call | Queue | Hashed `userId` | Persisted install UUID |
   |---|---|---|---|
   | `setEnabled(false)` | discarded | forgotten | **kept** |
   | `setConsent(_:)` revoking a group | discarded | forgotten | **deleted** |
   | `reset()` | flushed first | forgotten | regenerated (or deleted) |

   The opt-out is a *switch*: a person who turns it off and back on expects the
   same install, not a new one, and while it is off nothing is collected, so the
   retained UUID sits unused and reaches no backend. A consent revocation is a
   *withdrawal of permission to identify*, which
   [schema §11](docs/schema.md#11-consent) requires be unresumable — keeping the
   UUID would let a later grant continue a linkage the person had ended. If you
   want "stop collecting **and** forget me", call `reset()` after the opt-out.

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
  SAAS-HANDOFF.md          Handoff brief for a managed deployment of the engine
backends/
  README.md                How backends plug in + the shared conformance checklist
  cloudflare/              Cloudflare backend: Worker + D1, migrations, admin CLI,
                             conformance suite (npm test)
    ADOPTION.md            What the 0.2.0 hardening pass changed and how to adopt it
Sources/
  Stats/                   Core emitter: value types, client, queue, dispatcher
    StatsClient.swift        The actor: record / track / identify / consent / flush / reset / lifecycle
    Dispatcher.swift         Flush triggers, batching, backoff, drop-vs-retain
    EventStore.swift         JSON-lines durable queue + queue.head marker, compaction,
                             memory-only fallback
    StatsIdentityStore.swift Own UserDefaults suite: install UUID, seq, consent
    StatsEnvironment.swift   Context sampling (Bundle/ProcessInfo/uname/Locale only)
    Resources/
      PrivacyInfo.xcprivacy  Bundled manifest: tracking=false, UserDefaults CA92.1
  StatsCloudflare/         CloudflareSink (ingest) + StatsQuery (reads)
    IngestDisposition.swift  §7's status-to-behavior table as a pure function
    StatsTransport.swift     URLSessionTransport + defaultConfiguration()
  StatsTesting/            InMemorySink, ManualClock, fixed uuid/random providers
Tests/
  StatsTests/              Encoding, props, identity, sessions, consent, dispatch,
                             queue file + marker (QueueFileTests), record() (RecordTests)
                             — plus a test asserting the privacy manifest's contents
  StatsCloudflareTests/
.github/workflows/ci.yml   macos-15 pinned to Xcode 26.x: swift build + swift test,
                             an iOS Simulator build (so an #if os(iOS) fork is
                             compiled), plus the backend's typecheck and vitest suite
CHANGELOG.md               Keep-a-changelog, semver
```

## Status and roadmap

**Shipped (0.2.0).** Wire schema `v1`; the `Stats` core (file-backed queue,
dispatcher, identity, sessions, consent); the Cloudflare backend (ingest, read
endpoints, nightly rollup, per-batch and per-event idempotency); the
`StatsCloudflare` adapter (`CloudflareSink`, `StatsQuery`); a first consumer
app emitting events in production; and the read side validated end-to-end — a
Swift client emitting through `CloudflareSink` and reading its own
`summary` / `topEvents` / `propBreakdown` back through `StatsQuery` against the
Worker.

**Next.**

| Item | Notes |
|---|---|
| Hosted instance sign-up (`api.swiftstats.co`) | Operator-issued keys; the Worker is the same one in this repo |
| Global rate limiting for the Worker | Rate Limiting binding or a Durable Object per key — see `ADOPTION.md` |
| Optional background-task hook for the iOS flush-on-background | Consumer-supplied, so the core stays Foundation-only |
| 1.0 | API freeze once a second backend has shipped against `v1` |

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
