---
title: Delivery Guarantees: Idempotency, Backoff, Retention
type: note
permalink: swift-stats/architecture/delivery-guarantees-idempotency-backoff-retention
tags: [reliability, backoff, idempotency, retention]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [idempotency] batchId is a fresh UUID per batch construction; preserved across retries of that batch. Backend must deduplicate by batchId over minimum 24-hour window and return 202 for duplicates (same as first delivery). Emitter drop-oldest past 10k local queue depth. Single request in flight per client. #dedup #batchid
- [backoff] Exponential from 1s, doubling, full jitter, capped at 5min per attempt. No sending at all inside backoff window. 24-hour total retention ceiling; drop after and log at error. 429 with Retry-After is honored; absent Retry-After falls into backoff schedule. 5xx, timeouts, offline all treated identically (retry with backoff). #exponential-backoff #rate-limiting
- [re_split_on_413] If 413 Payload Too Large, emitter re-splits into smaller batches with new batchIds and retries. Single event exceeding 256 KiB is dropped (cannot be split). Batch size enforced by count (≤100) and bytes (≤256 KiB uncompressed); emitter splits by bytes first, then count. #batching #size-limits

## Relations
- is_specified_by [[Wire Schema v1 (Stable)]]
