# Identity, Users view and full audit — outcome (2026-10-05)

## Decisions (Alan)
- SDK per-install by default (`StatsConsent.default` includes `.identity`); per-user only via `identify(userID:)`.
- Dashboard "Count by: Installs | Users" (raw window only, counts never ids).
- Bring in the Sep 13 Retention work after audit; turn off invocation logs; read-only prod check allowed.

## Commits
swift-stats (main): 875b079, 2ab04e2 (identity warning, first-run claim), 215bcd5 (default includes .identity), 0e55f44 (invocation logs off), d97b6b3 (backend integrity: per-project rollups, cascade, raw_complete_from, budgeted nightly pass), ebad8ab (SDK: client ownership/forwarding, ephemeral seq, backlog safety, teardown races, RelaunchProbe), f4f60a7 (test prefs leak, firstSeenFloorDay docs).
swiftstats.co (main): 62002d4, 4790bfe (setup doc, identity notice), 98232f9 (shared identity check, Retention), 8682d53 (Users toggle), 7e382ca (relay fix, session IP/UA, site copy), 0d92052 (setup follow-ups from ScarfRack), 3952f3e (roles, resumable deletes, sign-in confirm, D1 cost).

## Verification
- Production read-only check: 7 projects all at 90 days, no orphans, nothing expired — no damage from the rollup/orphan bugs.
- End-to-end local test (real SDK → local ingest → D1 → rollup → read API): all 38 events, installs, sessions, seq, user ids, versions, debug split and rollups matched.

## Owner actions at deploy
- Backend: apply 0007 (required by new Worker) then 0008 (table rebuild; Time Travel bookmark first) — ADOPTION §11; wrangler.prod.toml (git-ignored) has invocation_logs=false locally.
- Dashboard: app_0010 before the Worker (npm run deploy does it); new 15-min cron; blank existing session ipAddress/userAgent once; magic links in flight at deploy 404 for ≤15 min.
- Cloudflare zone: turn off Web Analytics automatic injection (beacon contradicts the privacy policy).
- Bump swiftstats.co vendor/swift-stats + SWIFT_STATS_VERSION when the SDK is released; then update site copy that describes the 0.2.0 default.
- Optional: delete leaked test prefs (`find ~/Library/Preferences -maxdepth 1 -type f -name 'com.wizemann.stats.com.example.*.plist' -delete`).

## Open
- t-b462988f (iOS prewarm sentinel, persisted batchId, configured-consent downgrade).
- Pricing/tier enforcement copy (business decision).
