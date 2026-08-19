---
title: Consumer Responsibilities
type: note
permalink: swift-stats/conventions/consumer-responsibilities
tags: [checklist, consumer, contract]
source_sha: 62260b92163bc6f967af77253722d4f7322299d6
created: 2026-08-19
updated: 2026-08-19
reviewed: 2026-08-19
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [lifecycle] Call `applicationDidBecomeActive()` and `applicationDidEnterBackground()` from scene phase (typically `.onChange(of: scenePhase)`). SDK installs no AppKit/UIKit observers in v1; skipping them loses app_open / app_background events and flush-on-background. #required
- [privacy_declaration] App must declare Product Interaction and Other Diagnostic Data (neither linked to identity, neither used for tracking) in its own privacy manifest and nutrition label. Additionally declare User ID if and only if you call `identify(userID:)`. SDK's bundled manifest does not declare User ID (only the app does if needed). #privacy-manifest
- [salt] Choose a salt constant string (committed with app), never change it. Not a secret. Changing it silently re-identifies every install as new. #configuration
- [opt_out_control] Ship an opt-out toggle somewhere discoverable. `setEnabled(false)` for master switch; `setConsent(_:)` for granular revocation; `reset()` for full reset (new install, seq→0). Both calls persist. #ux-contract
- [context_sampling] Pass screenMetrics and colorScheme (need AppKit/UIKit) and isPreRelease (needs StoreKit context). SDK samples defaults (`0/0/1.0`, omitted, `false`). Consumer is on main actor and can read these cheaply. #app-supplied-context

## Relations
- enforces [[Privacy-First Design]]
- implements [[Consent & Identity Model]]
