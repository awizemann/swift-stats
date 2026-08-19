---
title: Testing Approach: Deterministic Injection
type: note
permalink: swift-stats/conventions/testing-approach-deterministic-injection
tags: [testing, determinism, injection]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [framework] Swift Testing only, no sleeps. Deterministic time: ManualClock you drive by hand. Fixed IDs: FixedUUIDProvider, FixedRandomSource. Recording sink: InMemorySink with configurable outcomes. No test needs to sleep; deterministic. #swift-testing #no-sleeps
- [injection_points] StatsClient configuration accepts `clock`, `uuidProvider`, and `randomSource` for injection. Tests drive time forward with `clock.advance(by:)`. All test utilities in StatsTesting product. #dependency-injection

## Relations
- enabled_by [[Swift 6 Isolation Architecture]]
- implements_principle [[Privacy-First Design]]
