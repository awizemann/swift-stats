---
title: Privacy-First Design
type: note
permalink: swift-stats/architecture/privacy-first-design
tags: [privacy, principles, schema]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [identifier] Only identifier: random UUID hashed with app-constant salt (SHA-256). No IDFV, IDFA, Keychain, device serial, IP storage, location, or freetext. Schema §13 explicitly lists what is never collected: 'no session replay, free text, device fingerprinting, or personally identifiable information'. #structural-guarantee
- [consent_default] Opt-out by default: consent defaults to `[.usage, .diagnostics]`. Identity consent is opt-in and must be explicitly requested via `identify(userID:)`. With no configuration, the SDK collects usage and diagnostics; opt-out via `setEnabled(false)` or `setConsent()`. #consent-model
- [tracking_claim] `NSPrivacyTracking` is `false`. No tracking domains. First-party data with non-correlatable id is not tracking. No ATT prompt. Bundled `PrivacyInfo.xcprivacy` asserts these facts; a test in StatsTests validates the manifest contents. #privacy-manifest
- [dependencies] Zero dependencies (Foundation and `os` only). No swift-log, no OpenTelemetry, nothing else to audit. 'Every Apple-platform analytics SDK asks you to choose between learn nothing and ship someone else's tracking SDK. swift-stats is the third option.' #supply-chain

## Relations
- is_enforced_by [[Consent & Identity Model]]
- is_documented_in [[Wire Schema v1 (Stable)]]
- constrains [[Consumer Responsibilities]]
