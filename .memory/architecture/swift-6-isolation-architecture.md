---
title: Swift 6 Isolation Architecture
type: note
permalink: swift-stats/architecture/swift-6-isolation-architecture
tags: [concurrency, isolation, sendable]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [language_mode] Builds in Swift 6 language mode with explicit `nonisolated`, `actor`, or `@MainActor` annotations on every declaration. NO `.defaultIsolation(MainActor.self)` in library — 'a library must be explicit about its own isolation so it behaves identically whether the consumer opts into MainActor-by-default or not'. #requirement #isolation-contract
- [concurrency_model] Queue and Dispatcher are actors. Protocol seams use `nonisolated protocol` so actors can conform without bridging. Sendable value types across every boundary. #actor-based
- [product_structure] Three Swift packages: Stats (core emitter), StatsCloudflare (Cloudflare backend adapter with CloudflareSink and StatsQuery), StatsTesting (test utilities: InMemorySink, ManualClock, FixedUUIDProvider, FixedRandomSource). #modularity

## Relations
- implements_principle [[Privacy-First Design]]
- enables_pattern [[Testing Approach: Deterministic Injection]]
- constrains [[Build Constraints]]
