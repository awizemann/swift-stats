---
title: Wire Schema v1 (Stable)
type: note
permalink: swift-stats/architecture/wire-schema-v1-stable
tags: [contract, schema, versioning]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [ingest_contract] POST /v1/events endpoint. Request envelope: `{schema: 'v1', batchId: UUID, sentAt: ISO8601-UTC-ms, context: {...}, events: [1-100]}`. Event: `{name: snake_case, ts: ISO8601-UTC-ms, sessionId, installId: 64-hex-SHA256, appId, projectId: derived-from-key, seq: monotonic-int, userId: optional, props: flat-object}`. Status 202 = accepted/durable; 400 = malformed (drop permanently); 401 = bad key (drop); 429 = rate-limit (retry with Retry-After); 5xx = transient (retry with backoff). #ingest #http-contract
- [context_once_per_batch] Context describes the app state when events were tracked, not at sentAt time. Sent once per batch: sdkVersion, appVersion, appBuild, bundleId, osName, osVersion, deviceModel, arch, locale, region, screenWidth/Height/Scale, isDebug, isTestFlight, colorScheme. Consent-reduced fallbacks are legal (e.g., 'unknown' for deviceModel, 'ZZ' for region, '0' for screen metrics when diagnostics consent denied). #context #consent-reduced-values
- [stability] Schema v1 is stable for v1 wire contract. Schema version is independent of SDK version: `Stats.schemaVersion` names the wire version; `Stats.sdkVersion` names the build. Unknown keys in envelope/event/context must be accepted by backend (forward compat); unknown `osName` and `arch` values must be stored verbatim (new Apple platforms). Breaking changes would create v2. #versioning #forward-compat

## Relations
- implements [[Privacy-First Design]]
- enables [[Pluggable Backends]]
