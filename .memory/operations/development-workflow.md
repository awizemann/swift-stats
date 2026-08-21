---
title: Development Workflow
type: note
permalink: swift-stats/operations/development-workflow
tags: [memory, git, credentials, process]
source_paths: [CLAUDE.md]
source_paths_inferred: false
source_sha: 677619ffc8e8943526b3f00837f51334fc97bf9c
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-code (background)
---

## Observations
- [memory_system] Managed by Memophant. Search memory before assuming; record durable decisions as memory notes (edit_memory rather than fork duplicates). Memory is the source of truth for architecture, conventions, decisions, operations, project state, roadmap. Notes filed under six folders (never root): architecture, conventions, decisions, operations, project, roadmap. #process
- [managed_tiers] Don't git add these tiers: .memory/, wiki/, design/, code/, sessions/, documents/, vendors/, templates/, TASKS.md, tasks/. User commits each via Memophant's per-tier secret-scanned bar. Everything else is yours to commit. #git-policy
- [secrets] Credentials → Keychain via set_vendor_credential; fetch with get_vendor_credential. Never leave loose in chat or files. #credentials
- [artifacts] Agent-generated artifacts (plans, reports, briefs) → documents/ (exact lowercase), via write_tier_file(tier:'documents', path:…). Not docs/ (project's own documentation) and not case-variants. #file-organization

## Relations
- governs [[Project Overview: swift-stats]]
