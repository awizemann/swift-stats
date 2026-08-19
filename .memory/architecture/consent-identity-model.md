---
title: Consent & Identity Model
type: note
permalink: swift-stats/architecture/consent-identity-model
tags: [consent, privacy-groups, identity]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [three_groups] Consent has three independent groups: `usage` (feature analytics), `diagnostics` (crashes, errors, performance), `identity` (stable install id + optional userId). Default is `[usage, diagnostics]`. Identity is withheld by default; apps must call `identify(userID:)` to grant it. Each group persists independently. #consent-structure
- [setEnabled_vs_setConsent] Two asymmetric operations: `setEnabled(false)` is an off-switch (queue discarded, install UUID retained, can turn back on and resume linkage). `setConsent(_:)` revoking a group is consent withdrawal (queue discarded, install UUID deleted if identity revoked, cannot resume linkage). `reset()` is full reset (new UUID, seq→0, userId forgotten). Intent: setEnabled is 'pause collecting'; setConsent revocation is 'forget me' per schema §11. #control-semantics
- [userId] userId is opaque, must be already-hashed before SDK, ≤128 scalars. Under `identity` consent only; omitted entirely when identity consent denied. Emitter must hash with install salt if given raw identifier. Not exposed in read contract (schema §8). Never used to link across projects. #user-identifier

## Relations
- implements [[Privacy-First Design]]
- specifies [[Consumer Responsibilities]]
