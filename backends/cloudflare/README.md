# Cloudflare backend — reserved (store decided: D1)

Nothing is implemented here yet. This folder is the reserved home for the
Cloudflare backend: a small ingest Worker on `POST /v1/events`, and a read layer
serving `GET /v1/summary` and `GET /v1/events/top`. The contract is
[`../../docs/schema.md`](../../docs/schema.md).

## Decided

**Store: D1**, chosen over Workers Analytics Engine for two reasons that outweigh
AE's lower write cost here:

- **Exact counts.** `activeInstalls`, `sessions` and `installs` become
  `COUNT(DISTINCT …)`, not HyperLogLog estimates. The conformance checklist makes
  a backend declare which it is, and a reader UI that has to hedge every number
  is a worse product. This backend will declare **exact**.
- **History.** Relational rows plus daily rollup tables let aggregates live
  indefinitely, which AE's fixed retention window does not allow.

The cost — we own the schema, the migrations and the retention job — is accepted.

**Retention.**

- Raw events: **90 days, MUST**, enforced by a scheduled deletion rather than by
  convention. This is the hard promise schema §13 asks a backend to make.
- **Daily rollups: kept indefinitely.** A rollup job aggregates raw events into
  per-day rows (per `projectId`, per `date`, per event name, per broken-down prop
  value) *before* the raw rows age out, so `/v1/summary` keeps answering ranges
  older than 90 days while nothing person-scale survives.
- Consequence to write down at implementation time: once a day's raw events are
  gone, no *new* dimension can be back-computed for it. The rollup shape is
  therefore part of the schema design, not an afterthought, and
  `/v1/events/top` over a range older than 90 days is answered from rollups only.

**Keys.** `projectId` is derived from the write key's scope (schema §2.4) — one
project per key, minted server-side, never trusted from the client. Read keys are
separately minted and separately project-scoped. Keys live in Worker secrets;
none of them belong in this repo.

## Still open, to settle when this is built

- The D1 table layout: the raw `events` table's indexes (`(projectId, ts)` at
  minimum) and whether `props` is a JSON column or a narrow key/value side table.
  The §8.2 breakdown query is the thing to design against.
- Where the `batchId` dedupe window lives: a D1 table with a scheduled purge, or
  KV with a 24 h+ TTL. KV is cheaper per batch; D1 keeps dedupe transactional
  with the insert, which is what makes "202 only when durable" easy to honor.
- Whether the Worker accepts `Content-Encoding: gzip` (schema §7 makes it
  optional and non-negotiated, so the answer only has to be written down here).
- The rollup job's trigger (a Cron Trigger) and how it handles a late-arriving
  offline batch for a day that was already rolled up.

When implemented, this README must cover the ten required items in
[`../README.md`](../README.md) and carry the filled-in conformance checklist.
