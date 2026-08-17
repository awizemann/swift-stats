# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **wire schema** in `docs/schema.md` is versioned independently of the
package; schema changes are called out explicitly below.

## [Unreleased]

### Added
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
  as a pure, tested function. `CloudflareSink` is written against the core sink
  API and excluded from the build until P12b defines `StatsSink`, `SinkOutcome`
  and `StatsBatch`.
- MIT `LICENSE`, `README.md`, this changelog, `.gitignore`, and a GitHub
  Actions workflow running `swift build` and `swift test` on `macos-15`.

### Not yet implemented
- The emitter itself — `StatsClient`, the file-backed event queue, the
  dispatcher, identity, sessions and consent — lands next. The quick-start in
  the README is the planned API and does not compile today.
- `CloudflareSink` (the `StatsSink` conformance in `StatsCloudflare`) is written
  but excluded from the build until the core sink API exists. The rest of
  `StatsCloudflare` — including the entire read side — builds and is tested today.

[Unreleased]: https://github.com/awizemann/swift-stats/commits/main
