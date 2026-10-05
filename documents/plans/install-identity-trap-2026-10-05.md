# Install-identity trap — plan and outcome (2026-10-05)

## Problem (verified in source)
- `StatsConsent.default = [.usage, .diagnostics]` — no `.identity`.
- Identity denied → each session start hashes a fresh random UUID, so installId changes per session; installs / active installs / first-seen / retention count sessions.
- CORRECTION found in audit: consent is persisted only by `setConsent`. Launch uses `storedConsent ?? configuration.consent`, so configured consent applies on every launch until the app first calls setConsent — NOT "first run only" (the brief, SDK docstring, wiki and memory all said otherwise).
- `setConsent`: `revoked = old - new`; adding a group is not a revocation.

## Decisions
- Recommend `.all` for apps that want install metrics; `identify(userID:)` not needed.
- Repair: app never calls setConsent → change configuration (fixed next launch; do NOT migrate, it would freeze consent). App calls setConsent → one-time flag-guarded helper: add `.identity` to the app's own consent record first, then `setConsent(current ∪ .identity)`.
- Privacy label: `.identity` without identify() → add Device ID (not linked, not tracking). With identify() → User ID, all categories linked.
- SDK: warn once per client at the first ephemeral install-id mint (not at prepare time, not gated on auto-events — autoEvents defaults to none). Public `hasStableInstallIdentity`.
- Dashboard: notice when ≥90% of last-7-day active installs were first seen in-window, ≥30 installs, ≥14 days history, prior week ≥0.5× this week's new installs.

## Outcome
- swift-stats `install-identity`: 875b079 (warning + property + tests + docs), 2ab04e2 (first-run claim corrected + relaunch test).
- swiftstats.co `install-identity`: 62002d4 (setup doc, wizard, site copy, anti-drift tests), 4790bfe (dashboard notice).
- Doc Swift compiled against SDK 0.2.0 in both isolation modes; both migration cases verified by runtime probe.
- Follow-ups: t-d73003c1 (Retention's separate uncommitted ephemeral check), t-ca1a0771 (wire schema §11 wording).
