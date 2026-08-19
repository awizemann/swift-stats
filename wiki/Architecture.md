---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: Sources/Stats/StatsClient.swift, Sources/Stats/Dispatcher.swift, Sources/Stats/EventStore.swift, Sources/Stats/StatsIdentityStore.swift, Sources/Stats/StatsEnvironment.swift, Sources/Stats/StatsSeams.swift, Sources/Stats/StatsSink.swift, Sources/Stats/StatsConfiguration.swift, Sources/Stats/StatsConsent.swift, Sources/StatsCloudflare/CloudflareEndpoint.swift, Sources/StatsCloudflare/CloudflareSink.swift, Sources/StatsCloudflare/IngestDisposition.swift, Sources/StatsCloudflare/StatsTransport.swift, Sources/StatsCloudflare/StatsQuery.swift, Sources/StatsCloudflare/StatsCloudflare.swift, docs/schema.md
source_paths_inferred: false
---

# Architecture

How the emitter is put together, and why each piece is shaped the way it is.
Everything below is drawn from `Sources/Stats/`, `Sources/StatsCloudflare/` and
`docs/schema.md`. For the contract itself see
[Wire Schema Reference](Wire-Schema-Reference); for API usage see
[Getting Started](Getting-Started).

## Three actors and one struct store

| Type | Kind | Responsibility |
|---|---|---|
| `StatsClient` (`Sources/Stats/StatsClient.swift`) | `actor` | Capture: validation, sessions, identity, `seq`, consent and the opt-out. |
| `Dispatcher` (`Sources/Stats/Dispatcher.swift`) | `actor` | *When* to send, and what to do with the answer (§7 retry policy). |
| `EventStore` (`Sources/Stats/EventStore.swift`) | `actor` | The durable JSONL queue and every byte of disk I/O. |
| `StatsIdentityStore` (`Sources/Stats/StatsIdentityStore.swift`) | `struct`, `@unchecked Sendable` | The SDK's own persisted state in its own `UserDefaults` suite. |

`StatsClient` is an actor so that identity, `seq`, session state and the queue
hand-off are serialized without a lock, and so a consumer cannot accidentally do
file I/O on the main actor by calling `track()` from a view. `EventStore` is a
separate actor because all I/O belongs off the main actor and behind one
serialization point. `Dispatcher` is separate again because "when to send" is a
policy with its own state (backoff windows, a retained batch, timers) that must
keep running while capture continues.

`StatsIdentityStore` is a `struct`, not an actor: its reads are small scalar
`UserDefaults` accesses made from the client actor, and making them `async` would
add suspension points that widen the window between capture and disk for no gain.
It is `@unchecked Sendable` because `UserDefaults` is documented thread-safe but
not marked `Sendable`. It opens a **dedicated suite** named
`com.wizemann.stats.<appId>` — never `.standard` — so it cannot collide with app
keys, is trivial to inspect, and `reset()` can wipe it wholesale. If the suite
cannot be opened, `isAvailable` is `false` and the SDK **fails closed**: no
collection at all, never a silent fallback to `UserDefaults.standard`.

The client's construction is deliberately inert: `init` resolves no paths, opens
no suite and reads no file. `prepareIfNeeded()` — synchronous, on the actor, at
the first entry point that needs it — opens the identity store, loads the
persisted consent / opt-out / `userId` hash, loads `seq`, and validates `appId`
and `projectId` locally so a malformed id is a log line rather than a permanent
400 per batch.

## The path of an event

```
record(name:props:)                     track(name:props:)
  │ nonisolated, Mutex-guarded buffer     │ async, on the actor
  │ timestamp taken at the call           │ timestamp taken at the call
  └────────► pumpRecorded() ──────────────┴────────► capture()
                                                       │ beginSessionIfNeeded()
                                                       │ consent / opt-out re-check
                                                       │ StatsEvent + context
                                                       ▼
                                                    pending [Record]
                                                       │ drainPending()
                                                       ▼
                                          Dispatcher.enqueue([Record])
                                                       │
                                                       ▼
                                          EventStore.append(records)  ──► queue.jsonl
                                                       │ returns depth
                                                       ▼
                                    triggers: depth >= flushAt · interval elapsed ·
                                              applicationDidEnterBackground()
                                                       ▼
                                              Dispatcher.performFlush()
                                                       │ EventStore.nextBatch(...)
                                                       ▼
                                              StatsSink.send(StatsBatch)
                                                       ▼
                              .accepted / .drop / .tooLarge / .retry(after:)
```

`capture()` builds a `StatsEvent` with the session id, the session's install id,
`appId`, the validated `projectId`, `seq`, a `userId` only when `identity`
consent is granted, and — for app events — props run through
`StatsProps.sanitized(_:eventName:)`. Auto-events bypass the reserved-name check
and their props are not sanitized; that is the only difference between an
auto-event and an app event on the wire. The record pairs the event with the
context that was current when it was tracked, because §1 forbids re-stamping a
queued batch with a newer context.

Outcome handling lives entirely in `Dispatcher.performFlush()`: `.accepted` and
`.drop` both `store.remove(through: pending.lastID)` (removal is by id, never by
position, so a head shift during a suspended flush can only remove *fewer*
records); `.tooLarge` re-splits; `.retry` retains and schedules the backoff.

## Ordering guarantees

Three mechanisms, each protecting a different hop:

1. **The `pending` buffer.** Two `await`s on the same actor are not guaranteed to
   resume in call order, so `await dispatcher.enqueue(...)` per event could write
   two concurrently tracked events to disk in the reverse of their `seq`.
   `capture()` appends synchronously to `pending` and a drain hands the buffer
   over, so on-disk order equals track order — which keeps batches `seq`-ascending
   (§2.2's SHOULD) and keeps drop-oldest meaningful.
2. **Chained drains.** `drainPending()` chains each drain `Task` onto the previous
   one's `value`, because two independent `await dispatcher.enqueue(...)` calls
   have no ordering guarantee of their own.
3. **The `record()` pump.** `record()` is `nonisolated` and appends to a
   `Mutex`-protected buffer, setting `pumpScheduled` so a burst creates one
   drainer rather than one per call. `pumpRecorded()` feeds entries through the
   same `capture()` path in order, with `drain: false`, so a burst of 1 000
   `record()` calls costs one `EventStore.append` instead of 1 000. Every
   `async` entry point (`track`, `flush`, `waitForFlushes`, `shutdown`, `reset`,
   `identify`, both lifecycle methods) calls `drainRecordedIfNeeded()` first, and
   `drainRecorded()` chains pumps through `recordedPumpTask`, so
   `record("a"); await track("b")` can never land as `b, a`.

At a session boundary `beginSessionIfNeeded()` drains `pending` after emitting
`session_end` / `session_start`, so the auto-events reach disk in the order §12
fixes, ahead of the event that opened the session.

`record()`'s buffer is capped (10 000 by default, overridable through a
`package` init for tests). At the cap the **newest** entries are dropped and a
single rate-limited error is logged — dropping the newest keeps the accepted
entries in order; the on-disk queue's own cap is the drop-*oldest* one.
`shutdown()` sets `isShutDown` before draining, so a later `record()` cannot
resurrect a drainer on a torn-down client.

## The on-disk queue

`EventStore` writes one JSON object per line to
`Application Support/<appId>/swift-stats/queue.jsonl`. `Application Support`
rather than `Caches`: the system may evict a cache at any moment, and a dropped
queue is data loss. JSON lines rather than one array: appending a line is one
`write(2)` at the end of the file, so `track()` does not get more expensive as
the queue grows, and a torn trailing line costs one event instead of the file.
Appends are not `fsync`ed — a deliberate trade against putting a disk flush on a
UI code path for data that is disposable by design.

**The `queue.head` marker.** A sidecar file holding
`"<consumedBytes> <fileSizeWhenWritten>\n"`. Removal advances the offset instead
of rewriting the queue file. A marker is accepted only when
`0 <= consumedBytes <= fileSizeWhenWritten <= actualSize` *and* the offset is
either 0 or immediately preceded by a newline; anything else (unparseable, past
the end, off a line boundary, tagged with a size the file never reached) is
ignored and the queue is read from byte zero. The failure direction is always
re-sending an accepted batch, never skipping unsent events. Because an append
only grows the file and never moves a byte before the offset, **appending writes
no marker at all** — no `stat`, no atomic write, no rename, no `chmod` per event.
The marker is read with a `FileHandle` bounded to 65 bytes so a foreign file in a
consumer directory is never read whole on launch. Paths that shrink or replace
the file either write the marker successfully or delete it (`discardHead()`).

**Compaction.** `shouldCompact` is `consumedBytes > 0 && consumedBytes >= liveBytes`
— the file is rewritten only once the dead prefix has grown to at least the size
of the live remainder, which bounds the rewritten bytes to O(1) per removed
record, amortized, instead of the O(n²) of rewriting per removal. The in-memory
`entries` slice uses the same rule: `rebaseIfNeeded()` copies only after as many
head slots are dead as there are live entries. `compact()` is public to the
package for an explicit idle/shutdown compaction, and doubles as a disk probe
while memory-only.

**Memory-only mode.** `performWrite` counts consecutive failures; three in a row
(`maxWriteFailures`) means the disk is not merely busy (full volume, read-only
container, deleted directory), so the store degrades to memory-only: appends skip
the disk, `needsRewrite` is set, and every 100 appends (`probeInterval`) — or on
any removal — `probeDisk()` attempts a full rewrite to find out whether the disk
came back. A marker write is deliberately *not* routed through `performWrite`: a
missing marker costs a replay, while degrading the whole store over it would cost
every unsent event on the next launch.

**Load ceiling.** A queue file larger than `defaultMaxLoadBytes` (64 MiB) is
discarded rather than read: 10k records of the largest plausible shape is ~5 MB,
so that size is corruption or an unbounded-growth bug, and a tail read would
resume from a line boundary nobody can trust. On load, malformed lines are
skipped and logged, the cap is re-applied (`loaded.count > maxQueued` truncates
from the front), and anything that leaves bytes belonging to no live entry
triggers a normalizing `rewrite()`.

**Batching.** `nextBatch(maxEvents:maxBytes:batchId:sentAt:)` takes head records
that share one context *and* the same `installId`, `appId` and `projectId` (§1 —
a mixed batch is a 400, and under denied `identity` consent the context bytes can
match while the install id differs). The byte budget is enforced before the count
limit, as §5 requires, by measuring the empty envelope once and then each event's
encoded bytes plus a comma. A head record that cannot be encoded is dropped in a
loop (not recursion — with a corrupt prefix, `maxQueued` stack frames would be a
crash).

**Permissions, backups, `ownsDirectory`.** A directory the SDK creates for itself
is created `0700` and marked `isExcludedFromBackup` once per process
(`didExcludeFromBackup`); every file the store writes (`queue.jsonl`,
`queue.head`) is set to `0600` after each write, because atomic writes replace the
file and would otherwise pick up the process umask. `ownsDirectory` is `true`
only when `storageDirectory` was `nil` — i.e. the default path or the
temporary-directory fallback `swift-stats-<appId>/`. A consumer-supplied
directory is created if missing and otherwise left exactly as the app set it: no
mode change, no backup exclusion. The `0600` on the files applies either way.

## The dispatcher

**Triggers.** `enqueue()` appends, then: if a retry is scheduled
(`isBackingOff`), it returns without sending; if the resulting depth is at least
`flushAt`, it flushes; else if `flushInterval` has elapsed since `lastFlushAt`, it
flushes; else it arms the interval timer (the first event of the process just
sets `lastFlushAt`, so the first flush is one interval *after* the first event,
not immediate). The third trigger is `applicationDidEnterBackground()`, which
calls `flushNow()`. `reset()` and `flush()` also go through `flushNow()`.

**One request in flight.** `startFlush()` chains each flush `Task` onto the
previous one's `value` rather than forking — stronger than a "busy" flag, because
a `flush()` caller awaits *its own* work. `flushGeneration` tracks task identity
so the chain is released when nothing newer was queued behind it.
`waitForFlushes()` awaits the chain but deliberately **not** the interval timer or
a scheduled retry: those are waits by design, and awaiting a wait would deadlock a
`ManualClock` test.

**§7 retry policy as implemented.**

- `.retry(after:)` **retains** rather than requeues: the events were never
  removed, so the next attempt rebuilds the identical batch. `retainedBatch`
  pins `(batchId, firstID, lastID, recordCount)` so the same `batchId` survives
  the retry (§6) and so the batch cannot silently absorb events appended
  meanwhile.
- **Head-moved check.** Before each attempt, if `store.headID != retained.firstID`
  the head moved under the retained batch (drop-oldest, or a discard), so the
  pinned id would label a different set of events — the retention is dropped and
  a fresh `batchId` issued.
- **413 → `.tooLarge`** sets `splitBudget = max(1, pending.events.count / 2)` and
  continues the loop with **new** batch ids (§6: a re-split batch is a new batch).
  A single event that cannot be split is removed and logged at `error`. The store
  applies the same rule locally: a lone event whose serialized batch exceeds
  256 KiB is dropped before it is ever sent.
- **Backoff.** Without a server hint: `backoffBase * 2^min(max(consecutiveRetries - 1, 0), 16)`,
  capped at `backoffCap`, multiplied by `randomSource.fraction()` — full jitter,
  uniform over `0...capped` — and floored at `backoffBase`, because a zero-second
  wait is a request loop, not a backoff. Full jitter rather than half is what stops
  a fleet that went offline together from returning in lockstep.
- **`Retry-After` clamps.** A server hint is authoritative and is *not* jittered.
  Only the floor is clamped in the dispatcher (`max(hint, backoffBase)`); the
  ceiling is `retentionCeiling`, not `backoffCap`, because §7 says "wait
  `Retry-After` if present, **else** the backoff schedule". `IngestDisposition`
  parses the header as integer seconds only (never the HTTP-date form) and caps it
  at 24 hours before it ever reaches the dispatcher.
- **24-hour ceiling.** `firstAttemptAt` is a **monotonic** reading of the first
  failed attempt on the head batch, so a device that was offline for two days
  still gets to try. Once `retentionCeiling` has passed, the retained batch is
  removed and logged at `error`.
- `retryNotBefore` gates *automatic* triggers so the backoff is a real wait; the
  scheduled retry itself calls `startFlush(force: true)` so it is not gated by the
  window it was scheduled against.

`discardAll()` (consent revocation, opt-out) cancels pending work and the
in-flight flush, clears the retention, backoff window, `firstAttemptAt` and
`splitBudget`, and empties the store. `shutdown()` cancels the timer and retry,
cancels the in-flight flush and awaits it, so no `store.remove` lands after the
owner believed the client was torn down.

Batch limits are constants on the dispatcher: `maxEventsPerBatch = 100`,
`maxBytesPerBatch = 262_144`.

## Sessions

All session state is in memory: a session never survives a process restart, since
§10 makes a launch always begin a session. `beginSessionIfNeeded(at:)` compares
`clock.monotonicNow() - session.lastActivity` against `configuration.sessionGap`
— on the **monotonic** clock, so a device clock change cannot fabricate or
suppress a session — and there is no timer at all: the gap is evaluated when
something is tracked.

The session id is `<epochSeconds>-<8 random digits>` (§10), with the seconds
clamped at 0 and zero-padded to 10 digits so a device reporting 1970 cannot emit
an id that fails §0's pattern and 400s the whole batch.

Order at a boundary is fixed:

1. `session_end` for the previous session (its own id, its `lastEventAt`, and
   `duration_s` = rounded seconds from `firstEventAt`) — emitted **before** the
   install id and context rotate, so it closes under the identity that session
   actually ran with.
2. Rotate `sessionInstallId` (persisted UUID's hash under granted `identity`, a
   fresh ephemeral hash otherwise) and sample `sessionContext`.
3. `session_start` for the new session.
4. Drain `pending`, so both auto-events land ahead of the event that opened the
   session.

`app_open` is emitted only from `applicationDidBecomeActive()`, at most once per
session (`didEmitAppOpen`) — never off the back of a `track()` in a process that
never foregrounded. `app_background` is emitted from
`applicationDidEnterBackground()` when a session exists. All four names are
opt-in through `StatsAutoEvents`, and `sessions` is one flag because a
`session_end` without its `session_start` would be unreadable.

## Identity, `seq` and consent

**Install id.** The raw UUID is persisted in the SDK's suite and never goes on
the wire; `installId = lowercaseHex(SHA256(uuidString + salt))` is derived at use
time (§9). With `identity` denied, the client hashes a *fresh* UUID per session,
so nothing is linkable across sessions and nothing identifying is written to disk.
`identify(userID:)` hashes with the same salt (warning if the value contains `@`),
keeps the hash in memory always, and persists it **only** while `identity` is
granted — §2.5's "remembered in memory but never emitted" would otherwise become
a linkage a later grant could resume.

**`seq`.** Loaded once in `prepareIfNeeded()`, incremented in memory
(`nextSeqValue`), and persisted once per drain — **before** the records are handed
to the dispatcher, so a crash between the two can only lose numbers, never repeat
them. §2.2 allows a gap, never a repeat. Previously it was an XPC round-trip to
`cfprefsd` per event.

**Revocation vs opt-out vs reset.**

| Call | Queue | Hashed `userId` | Persisted install UUID | `seq` |
|---|---|---|---|---|
| `setConsent(_:)` with a group revoked | discarded | deleted | **deleted** | 0 |
| `setEnabled(false)` | discarded | deleted | **kept** | untouched |
| `reset()` | flushed first | deleted | regenerated (deleted when `identity` denied) | 0 |

The asymmetry is §11's: an opt-out is a switch a person expects to flip back, and
nothing is collected while it is off, so the retained UUID sits unused; a consent
revocation is a withdrawal of permission to identify and must be unresumable.

Both teardown paths do **everything synchronous before their first `await`** —
clearing `pending`, clearing the `record()` buffer, ending session state, deleting
identity — so a `track()` that interleaves cannot find the revoked session
identity. `discardGeneration` covers the remaining race: a drain already suspended
in `dispatcher.enqueue(...)` compares the generation it captured after the hand-off
and, if it changed, discards the queue again.

## Context sampling

`StatsEnvironment.sampleContext(...)` (`Sources/Stats/StatsEnvironment.swift`) is
called once per session, off the main actor, and uses only `Bundle.main.infoDictionary`
(`CFBundleShortVersionString`, `CFBundleVersion`), `ProcessInfo.operatingSystemVersion`,
compile-time `#if os(...)` / `#if arch(...)` for `osName` and `arch`, `uname` (or
`sysctlbyname("hw.model")` on macOS) for `deviceModel`, and `Locale.current` for
`locale` and `region`.

**Not used, deliberately:** no `systemUptime`, no free disk space, no file
timestamps, no active-keyboard query — none of the required-reason APIs — so the
bundled manifest's single `UserDefaults` (CA92.1) entry stays truthful (§13, §14).
`UserDefaults` is the only required-reason API the SDK touches.

Values are normalized to the schema's shapes: `osVersion` drops a trailing `.0`
patch; iPadOS reports as `iOS` (telling them apart needs `UIDevice`, i.e. UIKit on
the main actor); `locale` strips keywords after `@`, converts `-` to `_` and
truncates to 32 scalars; `region` is uppercase alpha-2 or `ZZ`, from the device
region setting and never from an IP address (§13). Over-long `appVersion` /
`appBuild` are logged (field name and counts only, never the value), because §0
makes an over-long field a 400 for the whole batch. `isTestFlight` comes from the
consumer's `isPreRelease` and falls back to `false` — `Bundle.appStoreReceiptURL`
is deprecated in favour of StoreKit's `AppTransaction`, and importing StoreKit for
one boolean is not worth a framework on a cold path. Screen metrics and
`colorScheme` are consumer-supplied for the same reason. With `diagnostics`
denied, the sampled context is replaced by `sampled.diagnosticsDenied()`.

## The seams

Five protocols, all declared `nonisolated protocol` so an **actor can conform** —
the point being that a protocol which is implicitly `@MainActor` inside a consumer
module using `defaultIsolation(MainActor.self)` could not be conformed to by an
actor. Nothing in the package calls `Date.now` or `Task.sleep` directly.

| Seam | File | Provides |
|---|---|---|
| `StatsClock` | `Sources/Stats/StatsSeams.swift` | `wallNow()` (the wire's `ts`, `sentAt`, session-id prefix), `monotonicNow()` (§10's gap, backoff windows, the retention ceiling), `sleep(for:)`. Production: `SystemStatsClock` — `Date()` plus `ContinuousClock`, which keeps running while the device sleeps. |
| `StatsUUIDProvider` | `Sources/Stats/StatsSeams.swift` | Install identity (§9) and `batchId` (§6). Production: `SystemUUIDProvider`. |
| `StatsRandomSource` | `Sources/Stats/StatsSeams.swift` | `digits(count:)` for the 8-digit session-id suffix, `fraction()` for the full jitter. Production: `SystemRandomSource`. |
| `StatsSink` | `Sources/Stats/StatsSink.swift` | `send(_ batch: StatsBatch) async -> SinkOutcome`. **Sinks never throw** — the delete/retain/drop decision is schema-normative and cannot be derived from an arbitrary Swift error. |
| `StatsTransport` | `Sources/StatsCloudflare/StatsTransport.swift` | `perform(_ request: URLRequest) async throws -> StatsHTTPResponse`, so the Cloudflare adapter is testable without a network. |

`SinkOutcome` has exactly four cases — `.accepted`, `.retry(after:)`, `.tooLarge`,
`.drop(reason:)` — the four behaviours §7's response table prescribes, collapsed
to the only distinctions the dispatcher can act on.

## The Cloudflare adapter

`Sources/StatsCloudflare/` is the shipped backend adapter; see
[Cloudflare Backend](Cloudflare-Backend) for the Worker itself.

**`CloudflareEndpoint`** validates once, in a throwing initializer, rather than
per request: a scheme other than `https` throws `Failure.insecureScheme(host:)`
unless the host is loopback (`localhost`, `127.0.0.1`, `::1`, `[::1]`) — private
ranges and `.local` names are deliberately *not* exempted, since a write key
crossing a LAN in cleartext is what the check is for. A URL without a scheme or
host throws `.notAbsolute`. Trailing slashes are trimmed so path joining is exact.

**`CloudflareSink`** (`StatsSink`) POSTs to `StatsCloudflare.ingestPath`
(`/v1/events`) with `Content-Type: application/json; charset=utf-8`,
`X-Stats-Key: <writeKey>`, `User-Agent: swift-stats/<sdkVersion>` and
`httpShouldHandleCookies = false`. The body is `batch.serialized()` — never a
local `JSONEncoder` — because the dispatcher enforced §5's 256 KiB limit against
exactly those bytes. No `Content-Encoding`: gzip is optional and non-negotiated in
§7 and the backend does not accept it, so a gzipped body would be a permanent 400.
An unencodable batch is a `.drop`; a thrown transport error is
`IngestDisposition.transportFailure`, i.e. retain.

**`IngestDisposition`** is §7's table as a pure function of
`(statusCode, headers)`, kept separate from `SinkOutcome` so the part worth
testing needs no network and no batch to encode:

| Response | Disposition | `SinkOutcome` |
|---|---|---|
| 202 | `.accepted` | `.accepted` |
| other 2xx | `.retry(after: nil)` | `.retry(after: nil)` |
| 3xx | `.drop` — a redirect could move the write key | `.drop(reason:)` |
| 400 | `.drop` — malformed, never valid | `.drop(reason:)` |
| 401 | `.drop` — key missing, unknown or revoked | `.drop(reason:)` |
| 413 | `.resplit` | `.tooLarge` |
| 429 | `.retry(after: Retry-After)` | `.retry(after:)` |
| other 4xx | `.drop` — misconfiguration | `.drop(reason:)` |
| 5xx | `.retry(after: Retry-After if present)` | `.retry(after:)` |
| 1xx / out of range | `.retry(after: nil)` | `.retry(after: nil)` |
| transport error, timeout, offline | `.transportFailure` = `.retry(after: nil)` | `.retry(after: nil)` |

Headers are matched case-insensitively; `Retry-After` is parsed as integer
seconds only, must be positive, and is capped at `maxRetryAfterSeconds`
(24 hours).

**`URLSessionTransport`** builds its session from
`defaultConfiguration(allowsConstrainedNetworkAccess:allowsExpensiveNetworkAccess:)`:
`URLSessionConfiguration.ephemeral`, cookies refused and never set, `urlCache =
nil` with `reloadIgnoringLocalCacheData`, `timeoutIntervalForRequest = 20`,
`timeoutIntervalForResource = 60`, `networkServiceType = .background`,
`allowsConstrainedNetworkAccess = false` (Low Data Mode surfaces as a `URLError`,
which maps to retain-and-retry, so the batch stays queued rather than silently
never leaving) and `allowsExpensiveNetworkAccess = true`. Redirects are declined
with an explicit delegate, since `URLSession` follows them by default and §7
forbids following one automatically.

**`StatsQuery`** is the read side: `summary(projectId:from:to:includeDebug:)`
against `/v1/summary`, and `topEvents(...)` / `propBreakdown(...)` against
`/v1/events/top` (the latter adds `name`). It takes a `CloudflareEndpoint`, a
project-scoped **read** key (never embeddable in a shipped app) and an injectable
transport. Ranges are validated client-side: `from <= to` and at most
`maxRangeDays = 400` inclusive days, so an obvious mistake costs no round trip.
Results decode into `StatsSummary` / `StatsTopEvents` / `StatsPropBreakdown` value
types, and errors into `StatsQueryError`.

_Last updated: 2026-08-19 — rewritten from source_
