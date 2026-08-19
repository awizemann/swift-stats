# Handoff: swift-stats 0.2.0 hardening → managed SaaS engine

**Audience.** The team that runs the managed Cloudflare/API deployment of the
swift-stats engine (a fork/derivative of `backends/cloudflare`) and ships the
`Stats` / `StatsCloudflare` Swift packages to customers. This document is
self-contained and written to be pasted into a coding session as instructions.
The Worker-level detail (file/function, before → after, verify SQL) lives in
[`backends/cloudflare/ADOPTION.md`](../backends/cloudflare/ADOPTION.md); read
that second, after this.

**What happened.** A production-readiness audit of the package (2026-08-19)
found that the Swift client could never block or crash a host app, but had
write-amplification and durability defects under failure, and the Worker had a
handful of retry-policy and routing gaps. Everything below was fixed in the
open-source repo in 0.2.0. Two independent fresh-eye audits followed; their
residual findings are in §4.

---

## 1. Adopt: client-side changes that affect the service

You do not edit the client, but these change what your backend will see.

| Change | Service impact | Action |
|---|---|---|
| **`record()`** — new non-suspending API; `track()` remains | Burstier ingest: a client can buffer 10 000 events locally and flush them in ≤100-event batches | None required; confirm ingest rate limits tolerate a 100-batch burst per client (§3 of ADOPTION) |
| **`seq` cached, persisted once per drain before hand-off** | After a client crash `seq` can have *gaps*, never repeats | Do not alert on seq gaps; they are legal (schema §2.2) |
| **Byte-offset queue marker (`queue.head`)**; removals no longer rewrite the file | A crash between a 202 and the marker write can replay **≤1 batch under a fresh `batchId`** | Batch-level dedupe cannot catch it → adopt per-event idempotency (§2.1 below) |
| **URLSession defaults**: 20 s request / 60 s resource timeout, `.background` service type, `allowsConstrainedNetworkAccess = false` | Clients in Low Data Mode send nothing until it lifts; slow edges now see client timeouts at 20 s | Keep p99 ingest latency well under 20 s; a 413/503 path that takes >20 s is a silent retry loop |
| Queue dir excluded from backup, 0700/0600, memory-only after 3 write failures, 64 MiB load ceiling | None on the wire | — |

## 2. Adopt: Worker changes (summary — details in ADOPTION.md)

1. **Per-event idempotency** (ADOPTION §6, *new*): migration `0003_event_idempotency.sql` adds `UNIQUE (project_id, install_id, seq)` after collapsing existing duplicates; ingest uses `ON CONFLICT (project_id, install_id, seq) DO NOTHING`; deferred `events_deduped` log. **Run the migration during a quiet window; rollups computed before it may be inflated and are only re-rollable inside the 90-day raw window.** Schema §6/§2.2 were relaxed from "MUST NOT dedupe by (installId, seq)" to SHOULD — if your engine documents the contract to customers, mirror that wording.
2. **`ctx.waitUntil`** for all post-202 work and for cancelling unread bodies (ADOPTION §1).
3. **Storage-failure mapping** (ADOPTION §2/2a/2b): D1 "too big" → **413** (narrow matcher: `string or blob too big|SQLITE_TOOBIG|too many SQL variables`); anything unrecognized → 503 + `Retry-After`; the duplicate-check SELECT in the catch is guarded so a D1 outage is a 503, not a 500.
4. **Rate limiter is per-isolate/advisory** (ADOPTION §3): documented; `READ_LIMIT_PER_WINDOW = 120`; ingest limits deliberately not lowered (429 = RETAIN, so a low limit becomes a retry backlog).
5. **HEAD routed; `/health` method-checked** (ADOPTION §4).
6. **Maximal batch pinned by test** (100 events × 32 props, ADOPTION §5).

## 3. Investigate in the managed engine (not in the OSS Worker)

These were recommended, not implemented, because they need paid products or
tenant policy. Each has a rationale in ADOPTION "Recommended, not implemented".

- **Global rate limiting** — Cloudflare Rate Limiting binding or a Durable Object per write key; today's limits are per-isolate.
- **Per-tenant quotas / billing counters** — the only place to count accepted events reliably is the ingest path after the D1 commit; use `waitUntil`.
- **Cap on the rollup's expiring-day sweep** and **alerting on a missing `scheduled_done`** — the cron is idempotent but unbounded.
- **Key rotation ergonomics** — see ADOPTION §E.
- **Ingest latency budget** — with the new 20 s client timeout, anything that can exceed it (cold D1, large batch) should be measured.
- **Duplicate inflation audit** — after migration 0003, run the `dupes` verification query from ADOPTION §6 and decide whether to re-roll affected days.

## 4. Residuals you should know about (no action unless you disagree)

- Client: if `queue.head` can be neither deleted nor overwritten after a compaction (a pathological FS), a stale offset could alias a line boundary; logged, not escalated. The write-failure path otherwise fails toward **replay, never skip**.
- Client: under Low Data Mode nothing ships and the local queue drops oldest past 10 000; this is a documented knob (`allowsConstrainedNetworkAccess`).
- Client: the `record()` buffer drops **newest** past 10 000 and logs once; the on-disk queue drops **oldest** past `maxQueued`.
- Worker: `Retry-After` is honored up to 24 h; HTTP-date form not parsed.

## 5. Verification checklist for the adopting team

```bash
# Worker
cd backends/cloudflare && npm ci && npm run typecheck && npx vitest run   # expect all green
wrangler d1 migrations apply stats --remote                                # 0003 in a quiet window
# then the dupes query from ADOPTION.md §6 must return 0 rows

# Client (if you vend the package)
swift build && swift test
xcodebuild -scheme swift-stats-Package -destination 'generic/platform=iOS Simulator' build
```

Acceptance: ingest p99 < 5 s; zero `500` on ingest (only 202/400/401/413/429/503);
`events_deduped` present but low-volume in logs after rollout; no growth in
`batch_duplicate` after clients update to 0.2.0.
