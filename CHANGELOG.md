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
- MIT `LICENSE`, `README.md`, this changelog, `.gitignore`, and a GitHub
  Actions workflow running `swift build` and `swift test` on `macos-15`.

### Not yet implemented
- The emitter itself — `StatsClient`, the file-backed event queue, the
  dispatcher, identity, sessions and consent — lands next. The quick-start in
  the README is the planned API and does not compile today.
- The Cloudflare backend and its Swift adapter are placeholders.

[Unreleased]: https://github.com/awizemann/swift-stats/commits/main
