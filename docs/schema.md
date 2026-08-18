# swift-stats wire schema — `v1`

Status: **stable for `v1`** · Last changed: 2026-08-17

This document is the canonical contract between *any* emitter (the `Stats` Swift
SDK, a JS snippet on a Worker/Pages site, a curl script) and *any* backend
(`backends/cloudflare`, or one you write). It is normative: where this document
and an implementation disagree, the implementation is wrong.

The schema version is **independent of the SDK version**. `Stats.schemaVersion`
names the version an SDK build speaks; `Stats.sdkVersion` names the build.

**Keywords.** MUST / MUST NOT / SHOULD / MAY are used as in RFC 2119.

## 0. Conventions that apply everywhere

- Encoding is UTF-8 JSON. No BOM.
- All object keys are `lowerCamelCase` and are **case-sensitive**.
- Unknown keys: a backend MUST ignore keys it does not recognize rather than
  reject the batch. This is how `v1` grows without a version bump. This rule
  applies to the **envelope, event and context** objects only — it does **not**
  apply inside `props`, where every key is app-authored by design and §2.3's
  rules are the whole story.
- **Field format enforcement.** Any field whose value violates the format stated
  for it in §1, §2 or §3 (a `sessionId` not matching §10's pattern, an
  `installId` that is not 64 hex chars, an over-long `appId` or `userId`, a
  `projectId` with a disallowed character, a `bundleId` that differs from an
  event's `appId`, a malformed `ts`) MUST be rejected by the backend with **400** for the whole
  batch. The only fields exempt are the ones §3 explicitly says to store
  verbatim when unknown (`osName`, `arch`) and `props`, which follows §2.3.
- When two strings must be compared or ordered by this document, the comparison
  is **byte-wise ascending over the UTF-8 bytes**, not locale-aware and not
  UTF-16 — so Swift and JS implementations agree.
- Absent vs. null: an optional field MAY be omitted or sent as `null`; the two
  are equivalent. Emitters SHOULD omit rather than send `null`, except inside
  `props`, where `null` is a meaningful value (see §2.3).
- Timestamps are ISO 8601 in **UTC** with millisecond precision and a literal
  `Z`: `2026-08-17T14:03:11.482Z`. A backend MUST reject any other timestamp
  form. Emitters MUST NOT send local offsets (`+02:00`).
- Dates (in the read contract) are `YYYY-MM-DD`, UTC.
- Lengths in this document are counted in **Unicode scalars** (Swift
  `String.unicodeScalars.count`), not UTF-8 bytes and not grapheme clusters, so
  that Swift and JS emitters agree. Byte limits (§5) are counted in UTF-8 bytes
  of the serialized JSON.
- Numbers MUST be finite. `NaN` and `±Infinity` are not JSON and MUST NOT be
  emitted; an emitter that would produce one MUST drop that property instead.

## 1. The batch envelope

Every ingest request body is exactly one envelope object.

```json
{
  "schema": "v1",
  "batchId": "8B0B8AF0-3E9F-4F9F-9F1D-4E45B0A9C0D1",
  "sentAt": "2026-08-17T14:03:12.004Z",
  "context": { "...": "see §3" },
  "events": [ { "...": "see §2" } ]
}
```

| Field | Type | Req. | Notes |
|---|---|---|---|
| `schema` | string | yes | Exactly `"v1"` for this document. A backend MUST reject an unknown value with **400**. |
| `batchId` | string | yes | RFC 4122 UUID. Emitters MUST send the uppercase form; a backend MUST accept either case (and MUST NOT reject lowercase), uppercasing before it is used as a dedupe key — see §6. |
| `sentAt` | string | yes | When the emitter serialized the batch (§0). Distinct from each event's `ts`; the gap can be hours for a queued offline batch. |
| `context` | object | yes | Exactly one per batch, see §3. |
| `events` | array | yes | 1–100 event objects, see §2 and §5. An empty array MUST be rejected with **400**. |

A batch MUST NOT contain events for more than one `(appId, installId)` pair, nor
more than one `projectId` where that optional field is present — the emitter
partitions batches so that the single `context` and the key scope check (§7) are
unambiguous. A backend MUST reject a mixed batch with **400**.

`sessionId` **may** vary within a batch: a batch commonly spans a session
boundary, and `session_end` (§12) deliberately carries the *previous* session's
id. A backend MUST NOT reject a batch for containing more than one `sessionId`.

The `context` describes the app **at the time the events were tracked**, not at
the time of a later retry. An emitter MUST persist the context alongside queued
events and MUST NOT re-stamp a queued batch with a newer context — so events
tracked before an app update keep reporting the version that produced them. Only
`sentAt` and, after a re-split, `batchId` change between attempts.

## 2. The event object

```json
{
  "name": "project_opened",
  "ts": "2026-08-17T14:03:11.482Z",
  "sessionId": "1786012991-40371852",
  "installId": "3f8a1c9e5b2d47a08e6f1b3c9d0a7e42d5c81f9a0b3e6d2c4f7a19b8e05c3d6f",
  "appId": "com.wizemann.Overwatch",
  "projectId": "overwatch",
  "seq": 41,
  "props": { "section": "analytics", "count": 3, "cached": true }
}
```

| Field | Type | Req. | Notes |
|---|---|---|---|
| `name` | string | yes | See §2.1. |
| `ts` | string | yes | When the event occurred, per §0. Emitters MUST use the wall clock at `track()` time, not at flush time. |
| `sessionId` | string | yes | See §10. |
| `installId` | string | yes | 64 lowercase hex chars — SHA-256, see §9. |
| `appId` | string | yes | The emitting app's bundle identifier, e.g. `com.wizemann.Overwatch`. ≤ 128 scalars. |
| `projectId` | string | no | The tenant/rollup key a reader queries by. ≤ 64 scalars, `[A-Za-z0-9._-]` only. **The backend derives it from the write key's scope** — see §2.4. An emitter MAY send it; a mismatch with the key's scope is **400**. |
| `seq` | integer | yes | See §2.2. |
| `userId` | string | no | An opaque, app-supplied, already-hashed account identifier. Omit when unset — see §2.5. |
| `props` | object | no | See §2.3. Omit when empty. |

### 2.1 Event names

- 1–64 scalars, matching `^[a-z][a-z0-9_]*$` — lowercase snake_case.
- A backend MUST reject a batch containing a non-conforming name with **400**
  (the whole batch, not the single event: a malformed name means a broken
  emitter, and silent partial acceptance hides it).
- Emitters SHOULD use `noun_verb_past` (`project_opened`, `token_verified`).
- Names are **cardinality-bearing**: they become dimensions in the store.
  Emitters MUST NOT interpolate values into names (`project_42_opened`) — put
  the value in `props`, or, if it is high-cardinality, do not send it.
- Reserved names: see §12.

### 2.2 `seq`

A monotonically increasing integer counter starting at **0** for the first event
of a fresh install, scoped to `installId` and **never reset within an install** (it survives relaunch; it is
reset only by `reset()`, §9). Its purpose is ordering and gap detection:

- Two events with identical `ts` (same millisecond) are ordered by `seq`.
- A reader can detect dropped batches as gaps in `seq` per install.
- `seq` MUST be strictly increasing in the order events were tracked. Within a
  batch, `events` SHOULD be ordered by ascending `seq`; a backend MUST NOT rely
  on that ordering and MUST NOT reject an out-of-order batch.
- A backend MUST NOT treat `seq` as an idempotency key (a reinstall restarts at
  0). Idempotency is `batchId`, §6.

### 2.3 `props`

A **flat** map of app-authored properties.

- Value types: `string`, `number` (finite, §0), `bool`, or `null`. Nested
  objects and arrays MUST NOT be emitted; a backend MUST reject a batch
  containing one with **400**.
- `null` means "the app explicitly reports no value here" and is preserved
  distinctly from an absent key.
- Limits, per event:
  - at most **32** keys
  - key: 1–40 scalars, `^[a-z][a-z0-9_]*$`
  - string value: ≤ 200 scalars
- Enforcement is the **emitter's** job, and it enforces by *truncating and
  dropping*, never by discarding the event: over-long string values are
  truncated to 200 scalars, keys beyond the 32nd are dropped (the surviving 32
  are the first 32 in the byte-wise ascending key order of §0, so emitter and
  backend make the same choice), and a non-conforming key or a disallowed value
  type is dropped. Every such adjustment MUST be logged at
  `warning` by the emitter. A backend MUST also enforce the **size** limits (key
  count, key length, value length) and MAY
  either truncate/drop identically or reject with **400** — it MUST document
  which. A conforming backend SHOULD truncate/drop, so that an emitter bug
  degrades a property rather than losing a day of data. A **disallowed value
  type** (object or array) is not a size limit: it is always **400**, with no
  option to coerce, because coercion would silently invent a value.
- Properties MUST NOT carry free text typed by a person, file paths, URLs of
  user content, email addresses, tokens, or any other identifier of a person
  or their data. Counts, enum-like short strings, booleans and durations only.
  This is a contract, not a suggestion: it is what makes the privacy manifest
  in §13 truthful.

### 2.4 `projectId` — derived, not asserted

`projectId` is **authoritative from the write key**, not from the client. A write
key is provisioned scoped to exactly one `projectId`; the backend looks that up
and stamps every event in the batch with it.

- A backend MUST derive `projectId` from the presented `X-Stats-Key` and MUST
  store the derived value, never a client-supplied one.
- An emitter MAY include `projectId` on its events (it is useful in local logs
  and for a self-hosted backend that wants the redundancy). If present and it
  does **not** equal the key's scope, the backend MUST reject the batch with
  **400** — which is a permanent drop, so a misconfigured app fails loudly
  rather than quietly writing into the wrong project.
- If absent, the batch is perfectly valid; the derived value applies.
- A key scoped to more than one project is out of scope for `v1`. If that is ever
  needed, the client-supplied `projectId` becomes the selector *within* the
  key's scope — which is why the field exists in `v1` rather than being removed.
- The same rule holds for reads: a read key is project-scoped, and `projectId`
  on a read request is validated against that scope (§8), not trusted.

Consequence for the SDK: the app configures a `projectId` for its own clarity,
but it cannot mislabel traffic, and a leaked write key can only ever append to
the one project it was minted for.

### 2.5 `userId`

Optional. Present only when the app called `identify(userID:)`, and then on every
subsequent event of that install until `reset()` or a new `identify` call.

- ≤ 128 scalars. Opaque to the schema; no format is imposed.
- The value MUST already be hashed or otherwise opaque **before it reaches the
  SDK**. The SDK MUST NOT transmit a raw identifier: an emitter given something
  that looks like a raw identifier (an email address, in particular) SHOULD log
  at `warning`, and MUST hash the supplied value with the install salt (§9)
  before it goes on the wire, so that a careless consumer cannot leak a plaintext
  address to a backend.
- It MUST NOT be an email address, phone number, username, or any other value a
  person could be contacted or identified by outside the app's own database.
- Lives under the **`identity`** consent group (§11). When `identity` is denied
  the field MUST be omitted entirely — an `identify()` call is remembered in
  memory but never emitted — and `identify()` MUST NOT re-enable linkage that
  consent withheld.
- `reset()` (§9) clears it.
- A backend MUST treat it as an opaque string: it MAY index it for a per-account
  rollup, and MUST NOT expose it in the `v1` read contract (§8 has no `userId`
  dimension) or use it to join across projects.
- Sending a `userId` makes events for that account linkable, which is a real
  privacy cost. Apps that do not need per-account analysis SHOULD never call
  `identify()`.
- **Disclosure**: an app that uses `identify()` collects an account identifier
  and MUST declare **User ID** in its own privacy manifest and App Store
  nutrition label. The SDK's bundled manifest does not declare it, because the
  SDK does not collect one unless asked — see §14.

## 3. The context object

Sent **once per batch**, not per event. It describes the emitter as of the
moment the batch's events were tracked (§1), not as of `sentAt`. A backend
attributes every event in the batch to this context.

```json
{
  "sdkVersion": "0.1.0",
  "appVersion": "1.4.2",
  "appBuild": "318",
  "bundleId": "com.wizemann.Overwatch",
  "osName": "macOS",
  "osVersion": "15.4.1",
  "deviceModel": "Mac15,3",
  "arch": "arm64",
  "locale": "en_US",
  "region": "US",
  "screenWidth": 1512,
  "screenHeight": 982,
  "screenScale": 2.0,
  "isDebug": false,
  "isTestFlight": false,
  "colorScheme": "dark"
}
```

| Field | Type | Req. | Notes |
|---|---|---|---|
| `sdkVersion` | string | yes | Emitter version, e.g. `Stats.sdkVersion`. Non-Swift emitters use their own, prefixed: `js-0.1.0`. ≤ 32 scalars. |
| `appVersion` | string | yes | `CFBundleShortVersionString`. ≤ 32 scalars. |
| `appBuild` | string | yes | `CFBundleVersion`. String, not a number — build numbers are not always numeric. ≤ 32 scalars. |
| `bundleId` | string | yes | MUST equal each event's `appId`. |
| `osName` | string | yes | One of `macOS`, `iOS`, `iPadOS`, `visionOS`, `tvOS`, `watchOS`, `web`. Closed set in `v1`; a backend MUST accept an unknown value (store it verbatim) rather than reject, so a new Apple platform does not require a schema bump. `web` is **reserved for a future JS emitter** — out of scope for `v1`, but a backend MUST accept it rather than have to change later. |
| `osVersion` | string | yes | Dotted, e.g. `15.4.1` or `18.2`. Marketing version, not the Darwin kernel version. |
| `deviceModel` | string | yes | Raw model identifier: `Mac15,3`, `iPhone16,2`. **Not** a marketing name — mapping to "iPhone 15 Pro" is a reader-side concern. On the web, `web`. ≤ 64 scalars. |
| `arch` | string | yes | `arm64`, `arm64e`, `x86_64`, or `wasm32`. Unknown values stored verbatim. `wasm32` is **reserved for a future JS emitter**, as `web` is above. |
| `locale` | string | yes | POSIX-ish BCP 47 with underscore: `en_US`, `pt_BR`, or bare `de`. ≤ 32 scalars. |
| `region` | string | yes | ISO 3166-1 alpha-2, uppercase, e.g. `US`. `ZZ` when unknown. Derived from the device region setting — a backend MUST NOT derive it from client IP (see §13). |
| `screenWidth` | integer | yes | Points (not pixels) of the main screen / window scene. `0` when headless. |
| `screenHeight` | integer | yes | Points. `0` when headless. |
| `screenScale` | number | yes | Backing scale factor, e.g. `2.0`. `1.0` when unknown. |
| `isDebug` | bool | yes | True for a `DEBUG` build. Readers SHOULD exclude debug traffic from headline numbers by default. |
| `isTestFlight` | bool | yes | True for a TestFlight / sandbox-receipt install (on macOS, a non–App Store or sandbox receipt). Named `isTestFlight` on every platform for wire stability; read as "pre-release install". |
| `colorScheme` | string | no | `light` or `dark`. Omit when not applicable or not sampled. |

**Consent-reduced values are legal values.** When the `diagnostics` consent
group is denied (§11), the emitter sends the documented fallbacks, and a backend
MUST accept them without complaint even where they do not match the shape
described above: `osVersion` as a bare major version (`"15"`), `deviceModel` as
`"unknown"`, `locale` as a bare language (`"en"`), `region` as `"ZZ"`, and
screen metrics of `0` / `0` / `1.0`. These are the only permitted deviations, and
a backend MUST NOT treat them as a validation failure.

Every context field MUST be non-identifying on its own and in combination. A
field whose cardinality could single out a person (exact window size to the
pixel across a long session, precise timezone plus locale plus model) does not
belong here; the fixed list above is exhaustive for `v1`, and an emitter MUST
NOT add ad-hoc context keys — app-specific dimensions go in `props`.

## 4. Full example batch

```json
{
  "schema": "v1",
  "batchId": "8B0B8AF0-3E9F-4F9F-9F1D-4E45B0A9C0D1",
  "sentAt": "2026-08-17T14:03:12.004Z",
  "context": {
    "sdkVersion": "0.1.0", "appVersion": "1.4.2", "appBuild": "318",
    "bundleId": "com.wizemann.Overwatch", "osName": "macOS", "osVersion": "15.4.1",
    "deviceModel": "Mac15,3", "arch": "arm64", "locale": "en_US", "region": "US",
    "screenWidth": 1512, "screenHeight": 982, "screenScale": 2.0,
    "isDebug": false, "isTestFlight": false, "colorScheme": "dark"
  },
  "events": [
    {
      "name": "session_start", "ts": "2026-08-17T14:02:58.101Z",
      "sessionId": "1786012978-40371852",
      "installId": "3f8a1c9e5b2d47a08e6f1b3c9d0a7e42d5c81f9a0b3e6d2c4f7a19b8e05c3d6f",
      "appId": "com.wizemann.Overwatch", "projectId": "overwatch", "seq": 40
    },
    {
      "name": "project_opened", "ts": "2026-08-17T14:03:11.482Z",
      "sessionId": "1786012978-40371852",
      "installId": "3f8a1c9e5b2d47a08e6f1b3c9d0a7e42d5c81f9a0b3e6d2c4f7a19b8e05c3d6f",
      "appId": "com.wizemann.Overwatch", "projectId": "overwatch", "seq": 41,
      "props": { "section": "analytics", "cached": true, "tile_count": 6 }
    }
  ]
}
```

## 5. Size limits

| Limit | Value | Enforced by |
|---|---|---|
| Events per batch | ≤ **100** | emitter splits; backend rejects with **400** |
| Serialized batch body | ≤ **256 KiB** (262 144 bytes, UTF-8, uncompressed) | emitter splits; backend rejects with **413** |
| Props keys per event | ≤ 32 | §2.3 |
| Local queue depth | ≥ 10 000 events recommended, drop-**oldest** past the cap | emitter |

The emitter MUST split by the byte limit *before* the count limit — 100 small
events fit easily, but 100 events with 32 long props do not. A single event that
alone exceeds 256 KiB cannot be split; the emitter MUST drop it and log at
`error`. If the emitter compresses the body (`Content-Encoding: gzip`, §7), the
256 KiB limit applies to the **uncompressed** JSON, and the backend enforces it
after decompression; a backend MUST additionally cap the compressed body it
will read (2 MiB suggested) so a compression bomb cannot exhaust it.

## 6. Idempotency

`batchId` is a fresh UUID per **batch construction**, and is preserved across
retries of that batch: retrying after a 429 or 5xx MUST reuse the same
`batchId`. That is what makes at-least-once delivery safe.

A backend MUST deduplicate by `batchId` over a window of at least **24 hours**
(the emitter's retry ceiling plus a wide margin for an offline device that
resumes) and MUST return **202** for a duplicate, exactly as for a first
delivery — a duplicate is a success, not an error. Dedupe MAY be probabilistic
(e.g. a KV/D1 key with a TTL); a backend MUST document its window.

If an emitter re-splits a batch (e.g. after a 413), the resulting batches are
new batches and MUST get new `batchId`s.

Deduplication is per `batchId` only. A backend MUST NOT attempt to dedupe
individual events by `(installId, seq)`, because a legitimate reinstall
restarts `seq` at 0.

## 7. Ingest contract — `POST /v1/events`

Request:

```
POST /v1/events HTTP/1.1
Host: stats.example.com
Content-Type: application/json; charset=utf-8
X-Stats-Key: <write key>
Content-Encoding: gzip            # optional
User-Agent: swift-stats/0.1.0 (macOS 15.4.1)
```

Body: one envelope (§1).

| Header | Req. | Notes |
|---|---|---|
| `X-Stats-Key` | yes | The **write** key. Public-by-necessity (it ships inside the app binary), so it MUST be write-only: it grants nothing but "append events to the one project this key is scoped to". The key **determines** `projectId` (§2.4). A backend MUST reject a batch whose client-supplied `projectId` disagrees with the key's scope with **400**, and a missing, unknown or revoked key with **401**. |
| `Content-Type` | yes | MUST be `application/json`, optionally with `; charset=utf-8`. Anything else → **400**. |
| `Content-Encoding` | no | `gzip` only. Support is **optional for a backend but not discoverable at runtime** — there is no negotiation handshake in `v1`. An emitter MUST default to **uncompressed** and MUST compress only when the consumer explicitly configured it (having read the backend's README, which MUST state whether gzip is supported per `backends/README.md`). A backend that does not support gzip MUST reject a gzipped body with **400** rather than silently mis-parse; because a 400 is a permanent drop (§7 responses), a misconfigured emitter loses data, which is exactly why the default is off. |
| `X-Stats-Read-Key` | — | An emitter MUST NOT send it to this endpoint. A backend MUST **ignore** it here — never 400 or 401 on its presence, since a permanent drop is the emitter's response to those. |

Responses. The emitter's behavior for each is normative — this table is the
retry policy:

| Status | Meaning | Emitter MUST |
|---|---|---|
| **202** Accepted | Durably queued or written. Body ignored (empty or small JSON). | Delete the batch from the local queue. |
| **400** Bad Request | Malformed JSON, bad `schema` value, bad event name, a `stats_`-prefixed name, empty or over-100 `events`, an object/array props value, a batch mixing `appId`/`projectId`/`installId`, a `projectId` disagreeing with the write key's scope (§2.4), or any field violating its documented format (§0). | **Drop** the batch permanently. Log at `error`. Never retry — the batch will never become valid. |
| **401** Unauthorized | Missing, unknown or revoked write key. | **Drop** the batch. Log at `error`. Never retry; retrying a bad key is a self-inflicted DoS. |
| **413** Payload Too Large | Body over the byte limit. | Re-split into smaller batches with **new** `batchId`s and retry those. If a single event cannot be split, drop it and log at `error`. |
| **429** Too Many Requests | Rate limited. `Retry-After` (seconds, integer) SHOULD be present. | **Retain** the batch. Wait `Retry-After` if present, else the backoff schedule below. Do not increase concurrency. |
| **5xx** | Backend fault. | **Retain** the batch. Retry with the backoff schedule. |
| Transport error / timeout | Offline, DNS, TLS. | **Retain**. Same as 5xx. Never counted as a drop. |
| Any other 4xx (403, 404, 405, 415…) | Misconfiguration. | **Drop** the batch, log at `error`. Treat like 400. |
| 3xx redirect | — | MUST NOT be followed automatically (a redirect could move the write key to another host). Drop and log at `error`. |

Backoff: exponential from **1 s**, doubling, full jitter, capped at **5
minutes** per attempt, with a total retention ceiling of **24 hours** for a
batch, after which it is dropped and logged at `error`. At most **one request
in flight** per client. A backend MUST NOT require a client to pipeline.

A backend MUST return 202 only once the batch is durable enough that it would
survive the process dying. If it cannot, it MUST return 5xx and let the client
retry.

Other requirements:
- The endpoint MUST be HTTPS. An emitter MUST refuse a plain-`http` base URL
  except for `localhost`/`127.0.0.1` during development.
- The endpoint MUST NOT set cookies, and an emitter MUST NOT send or store them.
- The endpoint MUST NOT require CORS for the Swift SDK, but a backend intended
  for web emitters SHOULD support `OPTIONS /v1/events` preflight.
- A backend MUST NOT echo the request body in an error response.

## 8. Read contract

Reads use a **separate** key, `X-Stats-Read-Key`, which MUST NOT be embeddable
in a shipped client app. A write key MUST NOT grant reads, and a backend MUST
return **401** if the read endpoints are called with only a write key.

Read keys are **project-scoped** the same way write keys are (§2.4). The
`projectId` query parameter is validated against the key's scope, never trusted:
a request for a project the key does not cover MUST return **401**, and MUST NOT
distinguish "not authorized" from "no such project" — that distinction leaks the
existence of other projects.

Both read endpoints are `GET`, return `application/json`, and MUST be safe and
idempotent.

### 8.1 `GET /v1/summary?projectId=&from=&to=`

| Param | Req. | Notes |
|---|---|---|
| `projectId` | yes | Must be within the read key's scope, else **401**. |
| `from` | yes | `YYYY-MM-DD`, UTC, **inclusive**. |
| `to` | yes | `YYYY-MM-DD`, UTC, **inclusive**. `to` before `from` → **400**. A `to` after today (UTC) MUST be **clamped to today** — the response never contains future rows. A requested span (after clamping) longer than **400 days** → **400** with error `range_too_large`; a shorter span that exceeds the backend's retention MAY be clamped at the `from` end. The response's `from`/`to` always echo what was actually served, which may differ from what was asked. |
| `includeDebug` | no | `true`/`false`, default **`false`** — debug-build traffic is excluded from headline numbers unless asked for. |

```json
{
  "schema": "v1",
  "projectId": "overwatch",
  "from": "2026-08-01",
  "to": "2026-08-03",
  "includeDebug": false,
  "rows": [
    { "date": "2026-08-01", "opens": 412, "sessions": 388, "activeInstalls": 96, "events": 5104 },
    { "date": "2026-08-02", "opens": 377, "sessions": 351, "activeInstalls": 91, "events": 4712 },
    { "date": "2026-08-03", "opens": 0,   "sessions": 0,   "activeInstalls": 0,  "events": 0    }
  ]
}
```

Row semantics — these definitions are the contract; a reader that computes
them differently is not conformant:

| Field | Definition |
|---|---|
| `date` | The UTC calendar day of the event `ts` (never `sentAt`, never a local day). |
| `opens` | Count of `app_open` events that day. `0` if the app does not emit auto-events. |
| `sessions` | Count of **distinct `sessionId`s** with at least one event that day. A session spanning midnight UTC therefore counts in both days; the sum of `sessions` over a range is **not** the number of distinct sessions in that range. |
| `activeInstalls` | Count of distinct `installId`s with at least one event that day. Same non-additivity caveat: do not sum across days. |
| `events` | Count of all events that day, auto-events included. |

- Rows MUST be present for **every** day in the served range, sorted ascending
  by `date`, with days that have no events returned as explicit zeros. This is
  deliberate: a consumer chart must be able to trust the row count, and must not
  have to distinguish "no data" from "a missing row".
- If the range includes today, today's row carries the real counts **so far**,
  not zeros and not a projection. A caller that wants only complete days sets
  `to` to yesterday (UTC). A backend MUST NOT flag or annotate the partial row;
  the caller knows what it asked for.
- If the emitter's `identity` consent group is denied (§11) it sends a fresh
  ephemeral install id per session, so `activeInstalls` for that traffic
  approaches `sessions` rather than counting people. A backend cannot detect
  this and MUST NOT try; a reader presenting `activeInstalls` should know that
  it is "installs that were active", never "unique users".
- Counts are non-negative integers. A backend using approximate distinct counts
  (HyperLogLog, Analytics Engine) MUST say so in its backend README; readers
  MUST treat `activeInstalls` and `sessions` as estimates and MUST NOT present
  them as exact when the backend says they are approximate.

### 8.2 `GET /v1/events/top?projectId=&from=&to=[&name=][&limit=]`

Without `name`: the top event names by count. With `name`: the breakdown of
that one event's `props` values.

| Param | Req. | Notes |
|---|---|---|
| `projectId`, `from`, `to`, `includeDebug` | as §8.1 | |
| `name` | no | An event name (§2.1). Unknown name → **200** with an empty `rows`, not 404. |
| `limit` | no | 1–100, default **20**. Out of range or non-integer → **400**. Without `name`, it caps the total number of rows. With `name`, it caps rows **per `prop`** — so a breakdown of 5 props with `limit=20` returns up to 100 rows. |

Without `name`:

```json
{
  "schema": "v1", "projectId": "overwatch",
  "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
  "name": null, "limit": 20,
  "rows": [
    { "name": "app_open",       "count": 789, "installs": 96 },
    { "name": "project_opened", "count": 512, "installs": 88 }
  ]
}
```

With `name=project_opened`:

```json
{
  "schema": "v1", "projectId": "overwatch",
  "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
  "name": "project_opened", "limit": 20,
  "rows": [
    { "prop": "section", "value": "analytics", "count": 301, "installs": 71 },
    { "prop": "section", "value": "overview",  "count": 188, "installs": 63 },
    { "prop": "section", "value": null,        "count": 23,  "installs": 9  }
  ]
}
```

- Without `name`, rows are sorted by `count` descending, then `name` ascending
  (§0 byte order) as a deterministic tiebreak.
- With `name`, rows are grouped by `prop` — props ordered ascending by `prop`,
  and within each prop by `count` descending then `value` ascending, with the
  `null` row last.
- A `null` row counts events where the prop was present with a JSON `null`
  value **and** events where the prop was absent from that event entirely. The
  two are stored distinctly (§2.3) but are reported together here, because "the
  app did not report a section" is one thing to a reader. A backend that wants
  to separate them must add a new field in a later revision, not redefine this
  row.
- `installs` is distinct `installId` count for that row, and carries the same
  approximate-count caveat as §8.1.
- Only `string`, `bool` and `null` props are broken down. Numeric props MUST be
  omitted from the breakdown in `v1` — bucketing is not specified, and a naive
  breakdown of a continuous value is both useless and a cardinality hazard.
- A backend MAY cap the props it will break down (e.g. by cardinality) and MUST
  document the cap.

### 8.3 Read errors

**400** malformed params · **401** missing/invalid/out-of-scope read key ·
**404** unknown path only · **429** with `Retry-After` · **5xx** backend fault.
A reader SHOULD retry 429/5xx with the §7 backoff, and MUST NOT retry 4xx.
Error bodies are `{"error": "<machine_code>", "message": "<human text>"}`;
`error` values are backend-defined but MUST be stable snake_case strings.

## 9. Identity

- The install identifier is generated as a **random UUID v4** at first run, then
  hashed: `installId = lowercaseHex(SHA256(uuidString + salt))`, where `salt` is
  supplied by the app at configuration time and is the same on every install of
  that app. The UUID string is the uppercase RFC 4122 form; the concatenation
  is plain `uuid + salt` with no separator, UTF-8 encoded.
- The **raw UUID** is what is persisted; the hash is derived at use time. The
  raw UUID MUST NOT be transmitted.
- Storage: the SDK's **own `UserDefaults` suite** (a dedicated suite name, not
  `.standard`, so it cannot collide with app keys and is easy to inspect and
  clear). This is the only required-reason API the SDK touches (CA92.1).
- The identifier MUST NOT come from, or be stored in: the Keychain,
  `identifierForVendor`, the advertising identifier, a device serial, the
  MAC address, iCloud/CloudKit, or a shared app group. Consequences, accepted
  deliberately: the id does **not** survive app deletion, and it does **not**
  follow the user across the developer's other apps or across devices. Both are
  features — they are exactly what keeps this out of "tracking" territory.
- The salt exists so that the same random UUID cannot be correlated across two
  different apps or backends. It is not a secret and provides no security on its
  own; it MUST NOT be treated as one.
- `reset()` MUST: flush or discard pending events for the old identity,
  generate a fresh UUID, reset `seq` to 0, clear any `userId`, and start a new
  session. Events emitted before and after a reset MUST NOT be linkable by the
  backend.
- `identify(userID:)` sets the optional `userId` field (§2.5) on every subsequent
  event of that install. The SDK hashes the supplied value with the same salt
  before it goes on the wire, so a raw identifier never leaves the device, and
  the whole feature lives under the `identity` consent group (§11) — denied means
  the field is omitted. It is opt-in and most apps should not use it.
- A backend MUST NOT create its own identifier — no IP-derived id, no cookie,
  no fingerprint — and MUST NOT store the client IP alongside events (§13).

## 10. Session policy

- A session begins on **app launch** (first `track()` after process start), and
  on the **first activity after an inactivity gap**.
- Default inactivity gap: **30 minutes on macOS**, **5 minutes on iOS/iPadOS**.
  The asymmetry is intentional — a desktop app sits open and idle for long
  stretches, a phone app is backgrounded constantly. Consumers MAY override;
  emitters MUST document their default.
- The gap is measured from the last tracked event, and is evaluated when the
  next event is tracked (there is no timer, so no wakeups and no
  timing-dependent behavior).
- Session id format: **`<epochSeconds>-<8 random digits>`**, e.g.
  `1786012978-40371852` — `epochSeconds` is the integer UTC Unix time at session
  start, the suffix is exactly 8 decimal digits (zero-padded). The leading
  timestamp makes ids lexicographically sortable by start time, which is what
  makes cheap string-ordered storage useful. Total pattern:
  `^[0-9]{10,}-[0-9]{8}$`.
- Session ids are **not** globally unique by construction (two installs can
  collide in the same second). Uniqueness is per `installId`; a backend MUST
  key sessions on `(installId, sessionId)`, never on `sessionId` alone.
- A backend MUST NOT infer sessions itself, and MUST NOT expire or re-window a
  session id it receives. The emitter is the only authority on session
  boundaries.
- Clock changes: an emitter MUST use a monotonic clock to measure the
  inactivity gap, so a user changing the device clock cannot fabricate or
  suppress sessions; `ts` and the session-id prefix still come from the wall
  clock. A backend MUST tolerate an event whose `ts` is in the future or
  implausibly old (a device with a wrong clock, or a batch queued offline for
  weeks); it SHOULD clamp such a `ts` into its retention window for
  aggregation rather than drop the event, and MUST NOT reject the batch.

## 11. Consent

- **Opt-out by default, per app.** An emitter's default consent SHOULD be
  `usage` + `diagnostics`, and MUST NOT include `identity` — a stable
  `installId` and a `userId` change what the consuming *app* has to disclose
  (§14), so `identity` is granted in code or not at all.
- **A recorded `none` collects nothing.** With no groups granted, an emitter
  MUST collect nothing whatsoever: no queue file, no install id generated, no
  context sampled. An app whose privacy policy or jurisdiction requires
  opt-*in* configures `none` and records a choice before anything is collected.
- The choice is **per app**, persisted in the SDK's own UserDefaults suite, and
  survives relaunch. The persisted choice always wins over the configured
  default, which therefore applies exactly once, on first run.
- The end-user opt-out an app ships is the **master switch**, not consent, and
  the two differ deliberately about the install id: the master switch discards
  the queue but KEEPS the persisted install UUID (a person who turns it off and
  on again expects the same install, and nothing is collected while it is off),
  whereas revoking a consent group deletes it — see the revocation bullet below.
- Consent groups, independently togglable:
  | Group | Covers |
  |---|---|
  | `usage` | Event names, `props`, sessions, auto-events (§12). |
  | `diagnostics` | The context object's diagnostic fields: os/device/arch/screen/locale/region, `isDebug`, `isTestFlight`, `colorScheme`. |
  | `identity` | A stable `installId` across launches, and the `userId` field (§2.5). Denied → the emitter MUST use a **per-session ephemeral** install id (fresh random UUID per session, hashed the same way) so nothing is linkable across sessions, and MUST omit `userId` entirely even if the app called `identify()`. |
- `usage` denied means nothing is emitted at all, whatever the other groups say.
- `diagnostics` denied → the emitter still MUST send a well-formed `context`
  (the field is required), filling diagnostic fields with the documented
  unknown values: `osName` real (it is not identifying), `osVersion` the major
  version only (`15`), `deviceModel` `"unknown"`, `arch` real, `locale` the
  language only (`en`), `region` `"ZZ"`, screen `0`/`0`/`1.0`, `isDebug` and
  `isTestFlight` real, `colorScheme` omitted. `sdkVersion`, `appVersion`,
  `appBuild` and `bundleId` are always sent.
- Revoking consent MUST discard the local queue (not flush it) and MUST delete
  the stored install UUID, so that revocation cannot be undone into a resumed
  identity. Re-granting starts a new identity.
- A backend MUST NOT be told what the consent state is — it receives only what
  consent permitted. Consent is not on the wire.

## 12. Reserved event names

These four names are reserved by the schema; an app MUST NOT emit them
manually, and an emitter MUST reject an attempt to (log at `error`, drop the
event). They are produced only by the emitter's **opt-in** auto-event flags —
default **off**, in keeping with §11.

| Name | Emitted when | Props |
|---|---|---|
| `app_open` | The app becomes active in the foreground, at most once per session start. | none |
| `app_background` | The app leaves the foreground. Also the natural flush trigger. | none |
| `session_start` | A session begins (§10). First event of that session. | none |
| `session_end` | The previous session is retroactively closed: emitted lazily when the next session begins, carrying the **previous** session's `sessionId` and a `ts` equal to that session's last event. There is no timer and no process running after a kill, so a session that never resumes has **no** `session_end` — a reader MUST NOT assume every session has one, and MUST NOT compute session duration from `session_end` alone. | `duration_s` (number, whole seconds from first to last event of that session) |

**Ordering at a session boundary is fixed**: the emitter tracks `session_end`
(old `sessionId`) **first**, then `session_start` (new `sessionId`), then
`app_open` if enabled. So `session_end` carries the lower `seq`. Its `ts` is
deliberately **older** than the preceding event's `ts` — that is the one place in
`v1` where `ts` is not monotonic with `seq`. A backend MUST NOT reject or
reorder it, and MUST NOT infer session boundaries from `ts` ordering; §2.2's
"`seq` strictly increasing in track order" still holds and is the reliable order.

The `stats_` prefix is additionally reserved for future schema-level events.
Apps MUST NOT emit an event name starting with `stats_`; a backend MUST reject
one with **400** (a prefix check, so there is no reason to make it optional).

## 13. Deliberately never collected

The following are out of scope for `v1` and MUST NOT be added to it. Any of
them would break the privacy manifest in §14 and, mostly, the Apple
"not tracking" position.

- IP addresses. A backend necessarily *sees* the client IP at the edge; it MUST
  NOT store it, log it beyond an ephemeral rate-limit counter, put it in an
  event, or derive geography from it. Region comes from the device setting.
- Precise or coarse location, timezone offset, GPS, Wi-Fi/SSID, cell info.
- IDFA/IDFV, device serial, MAC address, or any hardware identifier.
- Names, email addresses, usernames, phone numbers, contacts, calendar.
- Free-text the user typed — search queries, note bodies, file names, file
  paths, document titles, URLs of user content.
- Screen recordings, session replay, screenshots, view hierarchies, automatic
  screen-name capture.
- Crash reports, stack traces, or logs (out of scope; use MetricKit/os_log).
- Purchase amounts, receipts, or payment details.
- Cross-app or cross-company joins, ad attribution, audience/segment export to
  any third party.
- Any required-reason API beyond `UserDefaults` (CA92.1).
- Third-party dependencies in the emitter.

Retention: a backend MUST document its raw-event retention and SHOULD keep raw
events no longer than **90 days**, aggregating beyond that. A backend MUST
provide a way to delete all events for a given `installId` on request, which is
the only per-person deletion this schema can support.

## 14. Privacy manifest

`Sources/Stats/Resources/PrivacyInfo.xcprivacy` is the SDK's manifest and MUST
stay consistent with this document:

- `NSPrivacyTracking`: `false`; `NSPrivacyTrackingDomains`: empty.
- Collected data types: **Product Interaction** (event names and `props`) and
  **Other Diagnostic Data** (the context object) — both *not linked to
  identity*, *not used for tracking*, purposes App Functionality + Analytics.
- Accessed API: `NSPrivacyAccessedAPICategoryUserDefaults`, reason **CA92.1**.

The package manifest deliberately does **not** declare `NSPrivacyCollectedDataTypeUserID`, because the SDK collects no
account identifier on its own. An app that calls `identify(userID:)` (§2.5) is
sending one, and **that app** must add User ID to its own manifest and nutrition
label. This is called out here because it is the one place where using an
optional SDK feature changes the consumer's disclosure obligations.

A consuming app must declare the same collected types in its own manifest and
answer the App Store nutrition label accordingly. `StatsTests` asserts these
values, so a change to the manifest that contradicts this section fails CI.

## 15. Versioning this document

- `v1` may gain **optional** fields and new enum values. That is not a breaking
  change and MUST NOT change the `schema` string; backends ignore unknown keys
  (§0) and accept unknown enum values where §3 says so.
- A breaking change — removing or renaming a field, tightening a limit,
  changing a semantic like §8.1's row definitions — requires `v2`, a new
  `schema` value, and a new path prefix (`/v2/events`). A backend SHOULD serve
  `v1` and `v2` side by side for at least one release cycle.
- A backend MUST reject a `schema` value it does not implement with **400**
  rather than guessing.
