# Backends

A **backend** is anything that accepts a swift-stats batch and (optionally)
serves the read contract back. The SDK does not care what it is: a Cloudflare
Worker, a Go binary, a Rails route, a file on disk.

The contract is [`../docs/schema.md`](../docs/schema.md) — normative, versioned
`v1`. Nothing else in this repo defines the wire format. If your backend and
that document disagree, your backend is wrong.

## Layout

One folder per backend:

```
backends/
  README.md            ← this file: the rules for all backends
  cloudflare/          ← reserved for P12c: Worker + Analytics Engine (or D1)
```

Each backend folder MUST contain its own `README.md` covering:

1. What it stores and where (engine, table/dataset shape, index/partition keys).
2. How to deploy it, from zero, with the exact commands.
3. How to run it locally for development.
4. Its **retention** period for raw events, and its aggregation beyond that.
5. Its **`batchId` dedupe window** and mechanism (§6 of the schema).
6. Whether `activeInstalls` / `sessions` / `installs` are **exact or
   approximate**, and if approximate, the error characteristics. Readers surface
   this to users, so it cannot be left implicit.
7. How write keys and read keys are provisioned, scoped to a project, and
   rotated — including how `projectId` is derived from the write key (§2.4).
8. Whether it supports `Content-Encoding: gzip`, and its compressed body cap.
9. Whether it truncates/drops or rejects on a props-limit violation (§2.3).
10. Its filled-in conformance checklist (below), with the commit it was verified
    at.

## Conformance checklist

A backend is conformant when every box is true. Copy this list into the
backend's README and check it off there — an unchecked list is a backend that
has not been verified, not a backend that is fine.

### Ingest — `POST /v1/events`

- [ ] Accepts the §1 envelope over HTTPS and returns **202** with an empty or
      small JSON body.
- [ ] Returns 202 **only after** the batch is durable enough to survive the
      process dying; returns 5xx otherwise rather than accepting-and-losing.
- [ ] Requires `X-Stats-Key`; returns **401** when it is missing, unknown or
      revoked.
- [ ] **Derives `projectId` from the write key's scope** (§2.4) and stores the
      derived value, never a client-supplied one. Accepts a batch with no
      `projectId`; rejects a supplied `projectId` that disagrees with the key's
      scope with **400**.
- [ ] Treats `userId` (§2.5) as an opaque string — never exposed in the read
      contract, never joined across projects.
- [ ] Grants **no read access** to a write key — read endpoints return 401 with
      only a write key.
- [ ] Requires `Content-Type: application/json` (`; charset=utf-8` tolerated);
      **400** otherwise.
- [ ] Rejects an unknown `schema` value with **400** — never guesses.
- [ ] Rejects `events: []`, > 100 events, a malformed event name, a
      `stats_`-prefixed name, and an object/array props value with **400**.
- [ ] Rejects with **400** a batch that mixes `appId` or `installId` (or supplies
      more than one `projectId`), and any field violating its documented
      format (§0).
- [ ] Rejects a body over 256 KiB (uncompressed) with **413**; caps the
      compressed body it will read.
- [ ] **Ignores unknown envelope/event/context keys** rather than rejecting
      (forward compatibility) — but does not extend that leniency into `props`.
- [ ] Accepts the consent-reduced context fallbacks of §3 (`osVersion` `"15"`,
      `deviceModel` `"unknown"`, `locale` `"en"`, `region` `"ZZ"`, zeroed screen)
      as valid.
- [ ] Accepts a lowercase `batchId`, uppercasing before keying the dedupe.
- [ ] Accepts a batch containing more than one `sessionId`, and a `session_end`
      whose `ts` is older than a lower-`seq` event's `ts` (§12).
- [ ] Ignores `X-Stats-Read-Key` on the ingest path — never 400/401 on it.
- [ ] Accepts an unknown `osName` / `arch` value, storing it verbatim.
- [ ] Deduplicates by `batchId` for ≥ 24 h, returning **202** for a duplicate.
- [ ] Does **not** dedupe by `(installId, seq)`.
- [ ] Tolerates a future-dated or very old `ts` without rejecting the batch.
- [ ] Emits `Retry-After` on **429**.
- [ ] Never echoes the request body in an error response.
- [ ] Sets no cookies and issues no redirects on the ingest path.
- [ ] Stores **no client IP**, no derived geography, and no identifier of its
      own invention (§9, §13).

### Read — `GET /v1/summary`, `GET /v1/events/top`

- [ ] Requires `X-Stats-Read-Key`, project-scoped; **401** otherwise, with an
      out-of-scope project indistinguishable from a nonexistent one.
- [ ] `date` buckets use the event `ts` in **UTC**, never `sentAt`, never a
      local day.
- [ ] `/v1/summary` **zero-fills every day** in the served range and sorts
      ascending.
- [ ] `sessions` = distinct `sessionId` per day; `activeInstalls` = distinct
      `installId` per day; both keyed per `installId` (a `sessionId` is not
      globally unique).
- [ ] `includeDebug` defaults to **false**.
- [ ] Clamps a `to` after today to today; rejects a span over 400 days with
      **400** / `range_too_large`; echoes the range actually served.
- [ ] `/v1/events/top` sorts by `count` desc with the documented tiebreak, honors
      `limit` (total rows without `name`, **per prop** with `name`), returns an
      empty `rows` for an unknown `name`, omits numeric props from breakdowns,
      and folds absent-prop into the `null` row.
- [ ] Errors use `{"error": "<stable_snake_case>", "message": "..."}`.
- [ ] Read endpoints are safe and idempotent — no writes, no side effects.

### Operational

- [ ] Documented retention, and it is actually enforced.
- [ ] A documented way to delete all events for one `installId`.
- [ ] Rate limiting that a well-behaved emitter following the §7 backoff never
      trips.
- [ ] A conformance test suite that can be run against a local instance, and
      instructions to run it.

## Adding a backend

PRs welcome. To add one:

1. Read `docs/schema.md` end to end. It is long on purpose; the ambiguities are
   already resolved there, so please do not re-decide them.
2. Create `backends/<name>/` with your implementation and a `README.md`
   containing the ten items above and the filled-in checklist.
3. Do not change `docs/schema.md` to fit your backend. If the schema is
   genuinely wrong or ambiguous, open an issue about the schema first — a fix
   there is a fix for every backend and every emitter.
4. Optional but welcome: a matching Swift adapter target (`StatsFoo`, depending
   only on `Stats`). It must stay zero-dependency and Swift 6 language mode
   like the rest of the package.
5. Keep secrets out of the repo — keys go in the platform's secret store, and
   READMEs reference them by name only.

## Choosing a backend

| | `cloudflare` |
|---|---|
| Status | Reserved — store decided, not yet implemented |
| Store | **D1** (decided) — Worker ingest, relational rows + daily rollups |
| Distinct counts | **Exact** (`COUNT(DISTINCT …)`) |
| Retention | Raw events 90 days; daily rollups indefinite |

More rows land here as backends do.
