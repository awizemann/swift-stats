---
title: Cloudflare Backend Implementation
type: note
permalink: swift-stats/architecture/cloudflare-backend-implementation
tags: [backend, cloudflare, worker, d1]
source_paths: [backends/cloudflare/README.md]
source_paths_inferred: false
source_sha: 677619ffc8e8943526b3f00837f51334fc97bf9c
created: 2026-08-19
updated: 2026-10-05
reviewed: 2026-08-19
reviewed_by: audit:claude-code (background)
---

## Observations
- [stack] Worker + D1 (SQLite). Conformance-checked backend: POST /v1/events (ingest), GET /v1/summary, GET /v1/events/top. Nightly Cron Trigger rolls up closed days and deletes raw events past 90 days. Distinct counts are exact. Keys stored only as SHA-256 hashes. projectId derived from write key scope. #implementation
- [deployment] Self-hosted on user's Cloudflare account. Deployment: `npx wrangler login && npm run deploy`. Conformance suite: `npm test` (typecheck + vitest). No hosted sign-up yet; self-hosting is the supported path. #self-hosted
- [retention] Raw event rows for 90 days, daily rollups kept indefinitely (per-day history survives, individual events behind it do not). #data-retention

## Relations
- implements [[Pluggable Backends]]
- is_specified_by [[Wire Schema v1 (Stable)]]
- provides_adapter [[Swift 6 Isolation Architecture]]


## 2026-10-05 integrity fixes (commit d97b6b3)
- [decision] Rollups are per project (`rollupStatements(env, day, rolledAt, projectId)`); a day-wide re-roll wiped other projects' rollups once their raw rows were gone. #rollup
- [decision] Raw tables cascade on project delete (migration 0008 rebuild); the sweep ages out orphans. Before 0008 a deleted project's events failed every project's nightly rollup and blocked retention. #retention
- [decision] `projects.raw_complete_from` (migration 0007) is set by `setProjectRetention` / admin `set-retention` on a raise; effective raw floor = max(retention cutoff, marker) for ingest clamping, `rawBoundaryDay` and the sweep. Retention must only be changed through those two paths. #retention
- [constraint] Nightly pass budget: D1 calls are Workers subrequests to Cloudflare services (1,000/invocation Free, 10,000 Paid); default 900, min 16, 10-minute wall stop, ≤31 expiring days per project per night, rotation by `rolled_at`. Workers Free cron CPU is 10 ms — watch for exceededCpu. #limits
- [gotcha] Migration order matters: the new Worker needs 0007; 0008 is a full table rebuild (take a Time Travel bookmark; can be applied separately per ADOPTION §11). #deploy
