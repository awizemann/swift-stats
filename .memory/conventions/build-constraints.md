---
title: Build Constraints
type: note
permalink: swift-stats/conventions/build-constraints
tags: [dependencies, build, api-usage]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [zero_dependencies] Stats product has no dependencies: Foundation and `os` only. No swift-log, no OpenTelemetry, nothing else to audit. A test in CI enforces this. #dependency-policy
- [required_reason_apis] Nothing requiring required-reason APIs beyond UserDefaults. UIKit/AppKit are not imported; consumers provide screenMetrics, colorScheme, isPreRelease. StoreKit is not imported (apps provide isTestFlight context). #api-surface
- [version_constraint] Swift 6.2 toolchain or newer, language mode 6. Platforms: macOS 15+, iOS 18+. Swift Testing framework for tests (no XCTest). #toolchain #platforms

## Relations
- enforces [[Privacy-First Design]]
