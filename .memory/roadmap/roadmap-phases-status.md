---
title: Roadmap: Phases & Status
type: note
permalink: swift-stats/roadmap/roadmap-phases-status
tags: [roadmap, phases, planning]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [completed_phases] P12a (package scaffold, schema v1, backend contract, CI): done. P12b (Stats core: file-backed queue, dispatcher, identity, sessions, consent, tests): done. P12c (backends/cloudflare/: ingest Worker on D1 + read helper): done. P12f (tag 0.1.0): done. #done
- [planned_phases] P12d (first consumer emits events): planned. P12e (read side: per-project usage in consumer app): planned. #planned
- [versioning_policy] Until 1.0, minor versions may make breaking API changes. Wire schema is versioned separately; schema v1 will not break. Semver policy starts at 0.1.0. #versioning

## Relations
- tracks_progress_of [[Project Overview: swift-stats]]
