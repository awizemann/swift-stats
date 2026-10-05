---
title: Consent & Identity Model
type: note
permalink: swift-stats/architecture/consent-identity-model
tags: [consent, privacy-groups, identity]
source_paths: [Sources/Stats/StatsConsent.swift, Sources/Stats/StatsClient.swift, Sources/Stats/StatsIdentityStore.swift]
source_paths_inferred: false
source_sha: e75995e7a188e9f5c8e9ab78851ca253c73aeec8
created: 2026-08-19
updated: 2026-10-05
reviewed: 2026-10-05
reviewed_by: claude-opus-5-5
---
## Observations
- [fact] Consent has three groups: `usage` (events, props, sessions, auto-events), `diagnostics` (the context object's diagnostic fields; denied → documented unknown values), `identity` (stable install id across sessions/launches + the `userId` field). Since the release after 0.2.0 (decision 2026-10-05: per-install by default, per-user only on request), `.default = [.usage, .diagnostics, .identity]` (== `.all`); 0.2.0 and earlier default to `[.usage, .diagnostics]`. Identity is granted via consent, NOT by `identify(userID:)`; identify() only adds a userId (per-user) and is ignored for emission while identity is denied. #consent-structure
- [gotcha] Without `.identity`, every session start hashes a fresh random UUID, so installId changes per session and installs / retention / first-seen installs count sessions. Only `setConsent` persists consent; launch uses `storedConsent ?? configuration.consent`, so an app that never called setConsent is repaired by changing its configuration (next launch). An app that has called setConsent needs a one-time `setConsent(current.union(.identity))` (adding a group is not a revocation) AND must add `.identity` to its own consent record, or a later setConsent(appRecord) revokes it. The new stable id applies from the next session start. The SDK warns once per client at the first ephemeral mint. #install-identity
- [fact] `setEnabled(false)` is an off-switch: queue discarded, userId hash forgotten, install UUID kept, so re-enabling resumes the same install. `setConsent(_:)` with ANY group going granted→denied (`revoked = old - new`) discards the queue, deletes the install UUID and resets seq to 0 — cannot resume linkage. `reset()` forgets the install (new UUID, seq→0, userId forgotten) without touching either switch. #control-semantics
- [fact] `identify(userID:)` takes the app's raw id and the SDK hashes it with the install salt before it leaves the device; the hash is stored and emitted only under `identity` consent. Not exposed in the read contract (schema §8); never used to link across projects. #user-identifier
- [decision] Privacy label: `.identity` without identify() → declare Device ID (not linked, not tracking) in addition to Product Interaction / Other Diagnostic Data; with identify() → User ID and all collected categories linked to the user. Documented in swiftstats.co setup/v1.md §7. #privacy-label

## Relations
- implements [[Privacy-First Design]]
- specifies [[Consumer Responsibilities]]
