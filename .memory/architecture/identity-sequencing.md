---
title: Identity & Sequencing
type: note
permalink: swift-stats/architecture/identity-sequencing
tags: [identity, sequencing, install-id]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [install_id] installId is SHA-256(randomUUID + appConstantSalt). Salt is not a secret; its purpose is to prevent the same UUID from being correlatable across apps or backends. Salt is committed with app; changing it silently re-identifies every install as new. #hashing #salt
- [seq] Monotonically increasing integer starting at 0 for fresh install, scoped to installId. Never reset within an install (survives relaunch); reset only by `reset()` or consent revocation of identity consent. Purpose: ordering identical-timestamp events, gap detection for dropped batches. seq is NOT an idempotency key (reinstall restarts at 0); batchId is idempotency key (§6). #sequence-number

## Relations
- implements [[Privacy-First Design]]
- is_specified_by [[Wire Schema v1 (Stable)]]
