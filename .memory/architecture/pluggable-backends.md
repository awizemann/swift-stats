---
title: Pluggable Backends
type: note
permalink: swift-stats/architecture/pluggable-backends
tags: [extensibility, backend, contract]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [backend_contract] Load-bearing artifact is the schema, not the SDK. Any backend speaking POST /v1/events (HTTPS only, no cookies) is valid. projectId is derived from the write key by backend (never trusted from client); a leaked write key only ever appends to its scoped project. Write key is public (ships in binary); read key must not be embeddable in shipped client (schema §8). #extensibility #contract
- [sink_protocol] `nonisolated protocol StatsSink: Sendable { func send(_ batch: StatsBatch) async -> SinkOutcome }`. Maps HTTP status → SinkOutcome (202→accepted, 429→retry(after:), 5xx/timeout→retry(after:nil), 413→tooLarge, others→drop(reason:)). Backend conformance checklist in backends/README.md. #protocol #pluggable

## Relations
- is_specified_by [[Wire Schema v1 (Stable)]]
- enabled_by [[Swift 6 Isolation Architecture]]
