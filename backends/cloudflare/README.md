# Cloudflare backend — reserved

Nothing is implemented here yet. This folder is the reserved home for the
Cloudflare backend: a small ingest Worker that validates and stores batches, and
a read layer serving `GET /v1/summary` and `GET /v1/events/top`.

Planned shape (decided in the plan, not yet built):

- **Ingest**: a Worker on `POST /v1/events`, validating against
  [`../../docs/schema.md`](../../docs/schema.md).
- **Store**: Workers Analytics Engine — write blobs/doubles/indexes, query over
  the SQL API, `index1 = projectId`. No schema migrations, cheap at small scale.
  Relational alternative if ad-hoc querying wins: D1 (we then own schema and
  retention).
- **Read**: the SQL API behind a read key, distinct from the write key.

Open, to settle when this is built:

- Analytics Engine distinct counts are **approximate**; `activeInstalls`,
  `sessions` and `installs` will have to be declared as estimates per the
  conformance checklist. If that is unacceptable for the reader UI, D1 wins.
- Where the `batchId` dedupe window lives (KV with a 24 h+ TTL is the obvious
  choice) and what it costs per batch.
- Whether the Worker accepts `Content-Encoding: gzip`.

When implemented, this README must cover the ten required items and carry the
filled-in conformance checklist from [`../README.md`](../README.md).
