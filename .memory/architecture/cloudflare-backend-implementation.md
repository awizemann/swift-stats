---
title: Cloudflare Backend Implementation
type: note
permalink: swift-stats/architecture/cloudflare-backend-implementation
tags: [backend, cloudflare, worker, d1]
source_paths: [backends/cloudflare/README.md]
source_paths_inferred: false
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [stack] Worker + D1 (SQLite). Conformance-checked backend: POST /v1/events (ingest), GET /v1/summary, GET /v1/events/top. Nightly Cron Trigger rolls up closed days and deletes raw events past 90 days. Distinct counts are exact. Keys stored only as SHA-256 hashes. projectId derived from write key scope. #implementation
- [deployment] Self-hosted on user's Cloudflare account. Deployment: `npx wrangler login && npm run deploy`. Conformance suite: `npm test` (typecheck + vitest). No hosted sign-up yet; self-hosting is the supported path. #self-hosted
- [retention] Raw event rows for 90 days, daily rollups kept indefinitely (per-day history survives, individual events behind it do not). #data-retention

## Relations
- implements [[Pluggable Backends]]
- is_specified_by [[Wire Schema v1 (Stable)]]
- provides_adapter [[Swift 6 Isolation Architecture]]
