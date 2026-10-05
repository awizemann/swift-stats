---
title: SDK client ownership, ephemeral seq and queue safety
type: note
permalink: swift-stats/decisions/sdk-client-ownership-ephemeral-seq-and-queue-safety
tags: [sdk, privacy, concurrency]
source_paths: [Sources/Stats/StatsClient.swift, Sources/Stats/EventStore.swift, Sources/Stats/Dispatcher.swift, Sources/StatsTesting/IsolatedDefaults.swift]
source_paths_inferred: false
source_sha: f4f60a73712979fbc12f2b2adbf0214cb9e3479e
created: 2026-10-05
updated: 2026-10-05
---

## Observations
- [decision] One owner per appId: a second StatsClient for the same appId forwards every call to the live owner (one hop, process-wide registry of weak owners); calls during the owner's shutdown wait and re-resolve. A different appId sharing a storageDirectory is refused (privacy calls logged at fault), never forwarded. Inert clients were rejected because they silently dropped opt-outs. #client-registry
- [decision] Under denied identity each ephemeral install id has its own in-memory seq from 0, never persisted; the persisted seq counts only the stable install. A shared counter let a backend chain per-session ids. #privacy
- [constraint] EventStore never replaces or rewrites the queue file until a load succeeds (iOS before first unlock reads fail with EPERM and are only waited out); persistent non-protection failures are quarantined to queue.unreadable, deleted by any discard. #data-loss
- [gotcha] Tests must not use real UserDefaults suites: cfprefsd rewrites deleted plists, so the suite leaked ~28k files. Tests use StatsConfiguration.identitySuiteDirectory (package) via StatsTesting IsolatedDefaults. #testing
- [todo] Deferred: iOS prewarm sentinel and persisted batchId (task t-b462988f). #roadmap

## Relations
- relates_to [[Consent & Identity Model]]
- relates_to [[Swift 6 Isolation Architecture]]
