---
title: Project Overview: swift-stats
type: note
permalink: swift-stats/project/project-overview-swift-stats
tags: [identity, status, privacy, analytics]
source_paths: [Package.swift, README.md, LICENSE]
source_paths_inferred: false
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [identity] Privacy-first usage analytics package for native Apple apps (iOS 18+, macOS 15+). Swift 6 with zero dependencies. Copyright (c) 2026 Alan Wizemann, MIT license. #project-identity
- [status] v0.1.0 released. Core emitter (Stats), Cloudflare backend adapter (StatsCloudflare), and test utilities (StatsTesting) all complete. Wire schema v1 stable and versioned independently from SDK. #release
- [vision] Third option between 'learn nothing' and 'ship someone else's tracking SDK': learn which features people use, say honestly you do not track anyone (structurally cannot), and choose your backend. #positioning

## Relations
- is_implemented_by [[Swift 6 Isolation Architecture]]
- is_specified_by [[Wire Schema v1 (Stable)]]
- is_operated_via [[Development Workflow]]
- progresses_through [[Roadmap: Phases & Status]]
