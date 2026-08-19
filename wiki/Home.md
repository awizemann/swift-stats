---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: README.md, docs/schema.md, CHANGELOG.md
source_paths_inferred: false
---

# swift-stats

**Privacy-first usage analytics for native Apple apps.** A small Swift package
(zero third-party dependencies, Swift 6 language mode, actors throughout), a
documented wire schema (`v1`) so the backend is yours to choose, and a shipping
Cloudflare Worker + D1 backend with a matching Swift adapter.

> **Current release: 0.2.0** (2026-08-19) — production hardening: bounded
> queue I/O, the non-suspending `record()` API, per-event idempotency on the
> backend. See the
> [CHANGELOG](https://github.com/awizemann/swift-stats/blob/main/CHANGELOG.md)
> for upgrade notes.

## Start here

| You are… | Read |
|---|---|
| Adding analytics to an app | [Getting Started](Getting-Started) — install, quick start, `record()` vs `track()`, consent, the consumer checklist |
| Understanding how the SDK works | [Architecture](Architecture) — the three actors, the durable queue and its marker, the dispatcher's retry policy, identity & sessions |
| Running or deploying the backend | [Cloudflare Backend](Cloudflare-Backend) then [Deployment & Operations](Deployment-&-Operations) — routes, data model, keys, migrations, runbooks |
| Writing a different backend or SDK | [Wire Schema Reference](Wire-Schema-Reference) — a reading guide to the normative [`docs/schema.md`](https://github.com/awizemann/swift-stats/blob/main/docs/schema.md) |
| Contributing | [Contributing & Testing](Contributing-&-Testing) — build, test, CI, release process, conventions |

## The five-line version

```swift
let stats = StatsClient(configuration: StatsConfiguration(
    appId: "com.example.MyApp", installIdSalt: "a-constant-per-app-string",
    sink: CloudflareSink(endpoint: try CloudflareEndpoint(string: "https://stats.example.com"),
                         writeKey: writeKey)))
stats.record("project_opened", props: ["section": "analytics"])   // never suspends the caller
```

## What makes it different

- **Structurally private.** One identifier — a random UUID hashed with your
  salt. No IDFV/IDFA, no IP storage, no location, no free text. The forbidden
  list is normative (schema §13) and the bundled `PrivacyInfo.xcprivacy`
  declares `NSPrivacyTracking = false`.
- **Never in your way.** Every entry point is actor-isolated; `record()` is
  non-`async`; construction does no I/O; sinks cannot throw; failures degrade to
  a log line and a retained or dropped batch — never a crash, never a blocked
  main thread.
- **The schema is the product.** Anything that speaks `POST /v1/events` is a
  valid backend. `v1` will not break.
- **Consent is three independent, persisted groups** — `usage`, `diagnostics`,
  `identity` — and the opt-out you ship is `setEnabled(false)`.

## Repository map

| Path | What |
|---|---|
| `Sources/Stats` | Core emitter: `StatsClient`, `Dispatcher`, `EventStore`, identity, context sampling |
| `Sources/StatsCloudflare` | `CloudflareSink` (ingest), `StatsQuery` (reads), `IngestDisposition`, `URLSessionTransport` |
| `Sources/StatsTesting` | `InMemorySink`, `ManualClock`, fixed uuid/random providers |
| `docs/schema.md` | ★ The wire contract (`v1`) |
| `docs/SAAS-HANDOFF.md` | Handoff brief for a managed deployment of the engine |
| `backends/cloudflare` | Worker + D1: migrations, admin CLI, conformance suite, `ADOPTION.md` |
| `.github/workflows/ci.yml` | macOS build+test, iOS compile check, Worker typecheck+tests |

## About this wiki

These pages are long-form guides that live in the repo's `wiki/` folder and
are managed by Memophant alongside the memory tiers (`.memory/` for atomic
facts, `design/` for design notes). Pages are grounded in the source files
named in each page's frontmatter; when code and wiki disagree, the code and
`docs/schema.md` win — fix the page. See [Wiki Maintenance](Wiki-Maintenance)
for conventions and the secret-scan that gates publishing.

---
_Last updated: 2026-08-19 — rewritten for 0.2.0_
