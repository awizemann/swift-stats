---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: backends/cloudflare
source_paths_inferred: false
---

# Deployment & Operations

How to stand up the Cloudflare Worker + D1 backend, upgrade it, and run it. For
what the code actually does, see [Cloudflare Backend](Cloudflare-Backend).

Everything below runs from `backends/cloudflare/`.

## Prerequisites

- A Cloudflare account, and `npx wrangler login`.
- Node 20+ (the admin CLI uses `node:crypto`'s `webcrypto` and top-level
  `await`; it has no dependencies).
- `npm install` in `backends/cloudflare/` — `wrangler`, `vitest` and the
  Workers types are devDependencies.
- Nothing else. There are no Worker secrets and one binding (D1).

## First deploy

```sh
cd backends/cloudflare
npm install

# 1. Create the database. Note the id it prints.
npx wrangler d1 create stats

# 2. Paste that id into wrangler.toml, replacing REPLACE_WITH_YOUR_D1_DATABASE_ID.

# 3. Apply the schema to the remote database.
npx wrangler d1 migrations apply stats --remote

# 4. Deploy. `npm run deploy` re-runs the migration apply and then `wrangler deploy`,
#    in that order, so the schema is never behind the code.
npm run deploy

# 5. Create a project and mint its keys.
node scripts/admin.mjs create-project overwatch "Overwatch" --remote
node scripts/admin.mjs mint-key overwatch write --label "macOS 1.4" --remote
node scripts/admin.mjs mint-key overwatch read  --label "Overwatch dashboard" --remote
```

Step 3 is listed separately because it is what a first deploy needs before
anything else works; `npm run deploy` from then on is the single command.

Verify with `curl https://<your-worker>/health` → `{"ok":true,"schema":"v1"}`.

### Custom domain

`wrangler.toml` ships the block commented out. Uncomment and set your own
hostname; Wrangler creates the DNS record on deploy.

```toml
[[routes]]
pattern = "api.example.com"
custom_domain = true
```

Delete the block entirely to stay on the `workers.dev` URL.

### A separate production config

The reference deployment keeps its real D1 id and route out of the shipped
`wrangler.toml` in a git-ignored `wrangler.prod.toml` — same `name`, `main`,
`compatibility_date`, `[triggers]` and `[observability]`, with the production
`database_id` and `[[routes]]` block.

```sh
npx wrangler deploy --config wrangler.prod.toml
npx wrangler d1 migrations apply stats --remote --config wrangler.prod.toml
```

The admin CLI honours `WRANGLER_CONFIG` and forwards it as `--config`, so it can
act on the same database without editing the shipped config (commit `74e7b90`):

```sh
WRANGLER_CONFIG=wrangler.prod.toml node scripts/admin.mjs list-keys overwatch --remote
```

## Local development

```sh
npm run migrate:local     # wrangler d1 migrations apply stats --local
npm run dev               # wrangler dev --local, http://localhost:8787
npm test                  # the conformance suite — no account, no network
npm run typecheck

node scripts/admin.mjs create-project overwatch "Overwatch" --local
node scripts/admin.mjs mint-key overwatch write --local
```

`http` is allowed for loopback only, and the SDK's `CloudflareEndpoint` enforces
exactly that.

## Upgrading to 0.2.0

The Worker change is migration `0003_event_idempotency.sql`: it collapses any
pre-existing duplicate `(project_id, install_id, seq)` rows (keeping the lowest
`id` — the first delivery) and then creates the UNIQUE index `events_identity`.

```sh
npx wrangler d1 migrations apply stats --remote
```

- **Run it in a quiet window.** The DELETE and the index build run once over the
  whole `events` table.
- Do not edit `0001` or `0002`; `0003` is additive and D1 records it as applied.
- Internal signatures changed: `handleIngest` / `route` now take
  `ExecutionContext`. A fork that calls them directly must pass `ctx`.

Verify afterwards:

```sh
npx wrangler d1 execute stats --remote --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND name='events_identity'"

npx wrangler d1 execute stats --remote --command \
  "SELECT COUNT(*) - COUNT(DISTINCT project_id || ':' || install_id || ':' || seq) AS dupes FROM events"
```

`dupes` must be `0`.

**The re-roll caveat.** The index repairs `events` only. Rollup rows written
*before* the migration may already have counted a replay, and rollups are kept
indefinitely while raw events are not. If the `dupes` query returned non-zero
before migrating, days still inside the 90-day raw window can be re-rolled from
the now de-duplicated raw events; for days whose raw rows are already gone the
inflated rollup is **not recoverable** and should be recorded as an accuracy
caveat on that date range rather than quietly served. Re-rolling is the ordinary
scheduled path re-run for a day — take the rollup lease into account
(`acquireRollupLease`, `src/rollup.ts`) and never run it concurrently with the
cron.

## Admin runbook

Every command takes `--local`, `--remote`, or `--dry-run` (prints the SQL and
exits — the safe way to review a destructive one). With neither `--local` nor
`--remote` and no `--dry-run`, the CLI refuses.

```sh
node scripts/admin.mjs create-project <id> "<name>" --remote
node scripts/admin.mjs mint-key <projectId> write|read [--label "text"] --remote
node scripts/admin.mjs list-keys <projectId> --remote
node scripts/admin.mjs revoke-key <64-hex key_hash> --remote
node scripts/admin.mjs delete-install <64-hex installId> --remote
```

- Project ids match `[A-Za-z0-9._-]{1,64}`; names and `--label` are 1–120 chars
  of letters, digits, spaces and `. _ , ( ) / + & # @ : -`.
- `mint-key` checks the project exists first, then prints the plaintext key
  **once** in a banner. Nothing writes it anywhere; only its SHA-256 goes to D1.
- `list-keys` shows hashes, kinds, labels and timestamps — never a key.
- `revoke-key` takes the **hash** from `list-keys`, and is an `UPDATE` setting
  `revoked_at`, so the row stays as an audit trail.

## Monitoring

`wrangler.toml` enables Workers observability:

```toml
[observability]
enabled = true

[observability.logs]
invocation_logs = true
```

Logs are one JSON line per event, from `src/log.ts`, whose `Fields` type is a
closed list: `projectId`, `day`, `events`, `rows`, `adjustments`, `deduped`,
`duplicate`, `durationMs`, `status`, `path`, `source`. Nothing person-scale is
ever logged — no `installId`, `sessionId`, `userId`, prop key or value, key or
key hash, request body, or IP. A caught error contributes a fixed classification
code (`constraint_violation`, `timeout`, `unclassified`, …), never the driver's
message text.

Event names to watch:

| Event | Level | Meaning |
|---|---|---|
| `batch_accepted` | info | a batch committed |
| `batch_duplicate` | info | duplicate `batchId`, answered 202 |
| `events_deduped` | info | events swallowed by the identity index |
| `props_adjusted` | warn | props truncated or dropped — an emitter bug is visible here |
| `duplicate_check_failed` | warn | the duplicate-check SELECT itself failed; the request 503s |
| `ingest_too_large_for_storage` | error | D1 refused for size → 413 |
| `ingest_rejected_by_storage` | error | D1 refused the shape → 400; means the validator and schema drifted |
| `ingest_failed` | error | unrecognized failure → 503 |
| `summary`, `events_top` | info | a read served; `source` is `raw` / `rollup` / `mixed` |
| `rolled_day`, `rolled_expiring_day` | info | a day rolled |
| `retention_swept` | info | raw rows deleted, with the cutoff day |
| `rollup_lease_held` | warn | another pass held the lease; this one did nothing |
| `rollup_failed`, `retention_skipped`, `retention_skipped_unrolled_day`, `retention_failed`, `rollup_lease_release_failed` | error | the scheduled job's failure modes |
| `scheduled_done` / `scheduled_failed` | info / error | the cron finished or threw |
| `unhandled` | error | an unexpected throw → 500 |

A nightly `scheduled_done` is the health signal for the cron. A sustained
`events_deduped` rate, or `deduped` equal to `events` on many batches, means an
emitter is not advancing its queue marker — an SDK bug, not a backend one.
`ADOPTION.md` notes that alerting on the scheduled job is recommended and not
implemented.

## Troubleshooting by status

The status *is* the emitter's retry policy, so reading it correctly matters:

- **400** — permanent drop. Check `Content-Type` (`application/json`), that the
  body is not gzipped, the `schema` value, batch size (1–100 events), and
  whether a client-supplied `projectId` disagrees with the write key's scope
  (`project_mismatch`). `ingest_rejected_by_storage` in the logs means the
  validator and the stored schema have drifted apart — a backend bug.
- **401** — one message for every cause: missing, unknown, revoked, or
  wrong-kind key, and on reads also an out-of-scope or malformed `projectId`.
  This is deliberate and cannot be narrowed from the response. Use `list-keys`
  to check the hash is present and `revoked_at` is empty, and confirm a *read*
  key is being used on read endpoints.
- **404** — unknown path only. Check the URL, not the project.
- **405** — wrong method; `Allow` says which. `/v1/events` is POST-only.
- **413** — the batch is too big or D1 refused it for size. The emitter
  re-splits; nothing to do unless it is constant.
- **429** — the limiter tripped. Remember the in-Worker numbers are per-isolate
  and advisory; a sustained 429 usually means the WAF rule, not the Worker.
- **503 with `Retry-After: 5`** — the honest "database, not data" answer. Batches
  are retained and retried. Check D1 health.
- **500** — an unexpected throw, logged as `unhandled` with the path.

## Client-side diagnostics

The SDK logs through `OSLog` under the subsystem in `StatsLog.subsystem`:

```sh
log stream --predicate 'subsystem == "com.wizemann.stats"'
```

The on-disk queue lives at
`Application Support/<appId>/swift-stats/queue.jsonl`, with the consumed-prefix
marker `queue.head` beside it (additive in 0.2.0; 0.1.0 queue files load
unchanged). A queue that never shrinks while `queue.head` never advances is the
shape that produces replays — which the backend's per-event idempotency
absorbs, and reports as `events_deduped`.

## Key compromise

1. Mint a replacement first, so there is no gap:
   `node scripts/admin.mjs mint-key <projectId> write --label "…" --remote`.
2. Ship it (a write key ships in the app binary; a read key belongs in a
   Keychain or a server-side secret store and must never be embedded in a
   shipped app).
3. Find the compromised key's hash with `list-keys`, then
   `node scripts/admin.mjs revoke-key <hash> --remote`.

Revocation takes effect on the next request — the Worker filters on
`revoked_at IS NULL` at lookup time. No deploy is involved: keys live in D1, not
in Worker secrets. There is no way to recover a lost plaintext key, by design.

## Erasure requests

```sh
node scripts/admin.mjs delete-install <64-hex installId> --remote
```

Raw `events` rows go immediately (the `events_install` index makes this one
scan). Rollups for days inside the nightly re-roll window self-correct on the
next pass, because the job is delete-then-insert rather than an upsert. For an
older day the rollup still carries that install's contribution as a number —
re-roll that day explicitly if it matters, and note that once the day's raw rows
are past the 90-day retention there is nothing left to re-roll from.

## What is not available

- **No self-serve key issuance.** There is no signup endpoint and no admin API.
  Projects and keys exist only via `scripts/admin.mjs`, which shells out to
  `wrangler d1 execute` using whatever credentials `wrangler` already has.
- **No manual rollup command.** `scripts/admin.mjs` has exactly five commands
  (`create-project`, `mint-key`, `list-keys`, `revoke-key`, `delete-install`)
  and `package.json` exposes only `dev`, `test`, `test:watch`, `typecheck`,
  `build:types`, `migrate:local`, `migrate:remote`, `deploy`. Re-rolling a
  specific day means running the scheduled path against the database yourself,
  respecting the lease.
- **No gzip ingest** — a compressed body is 400 `unsupported_encoding`.
- **No global in-Worker rate limit**, no per-tenant quota or billing counters,
  and no alerting on the scheduled job. All three are written up in
  `backends/cloudflare/ADOPTION.md` under "Recommended, not implemented".
- **No key recovery.** The plaintext is printed once and never stored.

_Last updated: 2026-08-19 — rewritten from backends/cloudflare sources_
