---
created: 2026-08-19
updated: 2026-08-19
source_sha: a512865d51bfdac164d5455b73541d993c3d1b6d
source_paths: docs/schema.md
source_paths_inferred: false
---

# Wire Schema Reference

`docs/schema.md` is the normative `v1` contract; this page is a condensed reading guide to it — where the two disagree, the schema wins.

Related: [Architecture](Architecture), [Cloudflare Backend](Cloudflare-Backend), [Getting Started](Getting-Started).

## Conventions ([§0](../docs/schema.md#0-conventions-that-apply-everywhere))

- UTF-8 JSON, no BOM. Keys are `lowerCamelCase` and case-sensitive.
- A backend MUST **ignore unknown keys** on the envelope, event and context objects (that is how `v1` grows without a version bump). This does not apply inside `props`.
- A field violating its documented format → **400 for the whole batch**. The only exemptions are `osName` and `arch` (stored verbatim when unknown) and `props` (§2.3).
- Timestamps: ISO 8601 UTC, millisecond precision, literal `Z` — `2026-08-17T14:03:11.482Z`. Local offsets MUST NOT be sent; any other form MUST be rejected. Read-contract dates are `YYYY-MM-DD`, UTC.
- String comparison/ordering is **byte-wise ascending over UTF-8 bytes**, so Swift and JS agree.
- Lengths are counted in **Unicode scalars**; byte limits (§5) in UTF-8 bytes of the serialized JSON.
- Omitted and `null` are equivalent for optional fields (emitters SHOULD omit) — except inside `props`, where `null` is meaningful.
- Numbers MUST be finite; an emitter that would produce `NaN`/`±Infinity` MUST drop that property.

## 1. Batch envelope ([§1](../docs/schema.md#1-the-batch-envelope))

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
| `schema` | string | yes | Exactly `"v1"`. Unknown value → **400**. |
| `batchId` | string | yes | RFC 4122 UUID. Emitters MUST send uppercase; backends MUST accept either case and uppercase before using it as a dedupe key (§6). |
| `sentAt` | string | yes | When the emitter serialized the batch — distinct from each event's `ts`. |
| `context` | object | yes | Exactly one per batch (§3). |
| `events` | array | yes | 1–100 events. Empty array → **400**. |

- A batch MUST NOT mix more than one `(appId, installId)` pair, nor more than one `projectId` where present; a mixed batch → **400**.
- `sessionId` **may** vary within a batch (`session_end` carries the previous session's id); a backend MUST NOT reject a batch for that.
- Context describes the app at **track time**, not retry time: an emitter MUST persist context with queued events and MUST NOT re-stamp it. Only `sentAt` and (after a re-split) `batchId` change between attempts.

## 2. Event object ([§2](../docs/schema.md#2-the-event-object))

| Field | Type | Req. | Notes |
|---|---|---|---|
| `name` | string | yes | §2.1. |
| `ts` | string | yes | Wall clock at `track()` time, not flush time. |
| `sessionId` | string | yes | §10. |
| `installId` | string | yes | 64 lowercase hex chars (SHA-256, §9). |
| `appId` | string | yes | Bundle identifier, ≤ 128 scalars. |
| `projectId` | string | no | ≤ 64 scalars, `[A-Za-z0-9._-]` only. Derived from the write key (§2.4); a mismatch is **400**. |
| `seq` | integer | yes | §2.2. |
| `userId` | string | no | Opaque, already-hashed account id (§2.5). |
| `props` | object | no | §2.3. Omit when empty. |

### 2.1 Names

1–64 scalars matching `^[a-z][a-z0-9_]*$`. A non-conforming name → **400 for the whole batch**, deliberately, so a broken emitter is not hidden by partial acceptance. Names SHOULD read `noun_verb_past` (`project_opened`). They are **cardinality-bearing** — emitters MUST NOT interpolate values into names (`project_42_opened`); the value goes in `props` or is not sent. Reserved names: §12.

### 2.2 `seq`

A monotonically increasing integer starting at **0** for a fresh install, scoped to `installId`, never reset within an install (only `reset()` resets it, §9).

- Two events with the same millisecond `ts` are ordered by `seq`; gaps per install reveal dropped batches.
- `seq` MUST be strictly increasing in track order. Events within a batch SHOULD be ascending by `seq`, but a backend MUST NOT rely on that and MUST NOT reject an out-of-order batch.
- A backend MUST NOT use `seq` alone as an idempotency key — only with `installId` (§6).

### 2.3 `props`

A **flat** map. Values may be `string`, finite `number`, `bool`, or `null`; nested objects/arrays MUST NOT be emitted and MUST be rejected with **400**. `null` means "explicitly no value" and is stored distinctly from an absent key.

Limits per event: at most **32 keys**; key 1–40 scalars matching `^[a-z][a-z0-9_]*$`; string value ≤ **200 scalars**.

Enforcement is the **emitter's** job and works by *truncating and dropping*, never by discarding the event: over-long strings truncate to 200 scalars, keys past the 32nd are dropped (keeping the first 32 in byte-wise ascending key order, so emitter and backend agree), non-conforming keys and disallowed value types are dropped — every adjustment logged at `warning`. A backend MUST also enforce the size limits and MAY truncate/drop or reject with **400**, and MUST document which; it SHOULD truncate/drop. A **disallowed value type** is never a size limit: always **400**, no coercion.

Props MUST NOT carry free text typed by a person, file paths, URLs of user content, email addresses, tokens, or any other identifier of a person or their data — counts, enum-like short strings, booleans and durations only.

### 2.4 `projectId` — derived, not asserted

A write key is provisioned scoped to exactly one `projectId`. The backend MUST derive `projectId` from the presented `X-Stats-Key` and store the derived value, never a client-supplied one. An emitter MAY send it; if it disagrees with the key's scope → **400** (a permanent drop, so a misconfigured app fails loudly). Absent is perfectly valid. A key scoped to more than one project is out of scope for `v1`. The same rule holds for reads (§8).

### 2.5 `userId`

Optional; present only after `identify(userID:)`, on every subsequent event until `reset()` or a new `identify`. ≤ 128 scalars, opaque, no format imposed.

- The value MUST already be hashed/opaque before it reaches the SDK; the SDK MUST NOT transmit a raw identifier, SHOULD log at `warning` if given something that looks like one (an email in particular), and MUST hash the supplied value with the install salt (§9) before the wire.
- It MUST NOT be an email, phone number, username, or anything a person could be contacted or identified by outside the app's own database.
- Lives under the **`identity`** consent group; denied → the field MUST be omitted entirely, and `identify()` MUST NOT re-enable withheld linkage. `reset()` clears it.
- A backend MUST treat it as opaque, MUST NOT expose it in the `v1` read contract, and MUST NOT use it to join across projects.
- An app that calls `identify()` MUST declare **User ID** in its own privacy manifest and nutrition label (§14).

## 3. Context ([§3](../docs/schema.md#3-the-context-object))

Sent **once per batch**. The list is exhaustive for `v1`; an emitter MUST NOT add ad-hoc context keys — app-specific dimensions go in `props`.

| Field | Type | Req. | Notes |
|---|---|---|---|
| `sdkVersion` | string | yes | ≤ 32 scalars; non-Swift emitters prefix (`js-0.1.0`). |
| `appVersion` | string | yes | `CFBundleShortVersionString`, ≤ 32 scalars. |
| `appBuild` | string | yes | `CFBundleVersion`, string not number, ≤ 32 scalars. |
| `bundleId` | string | yes | MUST equal each event's `appId`. |
| `osName` | string | yes | `macOS`, `iOS`, `iPadOS`, `visionOS`, `tvOS`, `watchOS`, `web`. Unknown values stored verbatim, not rejected. `web` is reserved for a future JS emitter. |
| `osVersion` | string | yes | Dotted marketing version (`15.4.1`), not the Darwin version. |
| `deviceModel` | string | yes | Raw identifier (`Mac15,3`, `iPhone16,2`), ≤ 64 scalars; `web` on the web. |
| `arch` | string | yes | `arm64`, `arm64e`, `x86_64`, `wasm32`; unknown stored verbatim. |
| `locale` | string | yes | BCP 47 with underscore (`en_US`, `pt_BR`, `de`), ≤ 32 scalars. |
| `region` | string | yes | ISO 3166-1 alpha-2 uppercase; `ZZ` when unknown. MUST NOT be derived from client IP. |
| `screenWidth` | integer | yes | Points, `0` when headless. |
| `screenHeight` | integer | yes | Points, `0` when headless. |
| `screenScale` | number | yes | Backing scale, `1.0` when unknown. |
| `isDebug` | bool | yes | True for a `DEBUG` build. |
| `isTestFlight` | bool | yes | Pre-release install; named `isTestFlight` on every platform for wire stability. |
| `colorScheme` | string | no | `light` or `dark`; omit when not applicable. |

**Consent-reduced values are legal values.** With `diagnostics` denied the emitter sends `osVersion` as a bare major (`"15"`), `deviceModel` `"unknown"`, `locale` a bare language (`"en"`), `region` `"ZZ"`, screens `0`/`0`/`1.0` — a backend MUST accept these and MUST NOT treat them as validation failures. These are the only permitted deviations.

## 5. Size limits ([§5](../docs/schema.md#5-size-limits))

| Limit | Value | Enforced by |
|---|---|---|
| Events per batch | ≤ **100** | emitter splits; backend **400** |
| Serialized batch body | ≤ **256 KiB** (262 144 bytes, UTF-8, uncompressed) | emitter splits; backend **413** |
| Props keys per event | ≤ 32 | §2.3 |
| Local queue depth | ≥ 10 000 events recommended, drop-**oldest** past the cap | emitter |

Split by the **byte** limit before the count limit. A single event over 256 KiB cannot be split: drop it and log at `error`. With `Content-Encoding: gzip` the 256 KiB applies to the *uncompressed* JSON, enforced after decompression; a backend MUST additionally cap the compressed body it reads (2 MiB suggested) against compression bombs.

## 6. Idempotency ([§6](../docs/schema.md#6-idempotency))

`batchId` is fresh per **batch construction** and preserved across retries of that batch — retrying after 429/5xx MUST reuse it. A backend MUST dedupe by `batchId` over a window of at least **24 hours**, MUST return **202** for a duplicate exactly as for a first delivery, MAY dedupe probabilistically, and MUST document its window. A re-split (e.g. after 413) produces **new** `batchId`s.

Additionally, a backend **SHOULD** treat `(projectId, installId, seq)` as a per-event idempotency key, storing at most one event per triple and keeping the first delivery. This catches an emitter that is acknowledged, crashes before its queue marker is durable, and re-sends under a new `batchId`. A backend MUST NOT dedupe on `seq` without `installId`, and MUST NOT dedupe across `projectId`s.

## 7. Ingest — `POST /v1/events` ([§7](../docs/schema.md#7-ingest-contract--v1events))

Headers:

| Header | Req. | Notes |
|---|---|---|
| `X-Stats-Key` | yes | The **write** key — public by necessity, so write-only, scoped to one project and determining `projectId` (§2.4). Client `projectId` disagreeing with scope → **400**; missing/unknown/revoked → **401**. |
| `Content-Type` | yes | `application/json`, optionally `; charset=utf-8`. Anything else → **400**. |
| `Content-Encoding` | no | `gzip` only, not runtime-discoverable. Emitters MUST default to uncompressed and compress only when explicitly configured; a backend without gzip MUST reject a gzipped body with **400** rather than mis-parse. |
| `X-Stats-Read-Key` | — | MUST NOT be sent here; a backend MUST **ignore** it (never 400/401 on its presence). |

Response table — the emitter behavior is normative:

| Status | Meaning | Emitter MUST |
|---|---|---|
| **202** Accepted | Durably queued or written; body ignored. | Delete the batch from the local queue. |
| **400** Bad Request | Malformed JSON, bad `schema`, bad event name, a `stats_`-prefixed name, empty or over-100 `events`, an object/array props value, a batch mixing `appId`/`projectId`/`installId`, a `projectId` disagreeing with the key's scope, or any field violating its format (§0). | **Drop** permanently, log at `error`. Never retry. |
| **401** Unauthorized | Missing, unknown or revoked write key. | **Drop**, log at `error`. Never retry. |
| **413** Payload Too Large | Body over the byte limit. | Re-split with **new** `batchId`s and retry those; an unsplittable single event is dropped and logged at `error`. |
| **429** Too Many Requests | Rate limited; `Retry-After` (integer seconds) SHOULD be present. | **Retain**. Wait `Retry-After`, else the backoff. Do not increase concurrency. |
| **5xx** | Backend fault. | **Retain**, retry with backoff. |
| Transport error / timeout | Offline, DNS, TLS. | **Retain**, same as 5xx. Never counted as a drop. |
| Any other 4xx (403, 404, 405, 415…) | Misconfiguration. | **Drop**, log at `error`. Treat like 400. |
| 3xx redirect | — | MUST NOT be followed automatically. Drop and log at `error`. |

Backoff: exponential from **1 s**, doubling, full jitter, capped at **5 minutes** per attempt, with a **24 hour** total retention ceiling, after which the batch is dropped and logged at `error`. At most **one request in flight** per client.

A backend MUST return 202 only once the batch would survive the process dying, else 5xx. The endpoint MUST be HTTPS (an emitter refuses plain `http` except `localhost`/`127.0.0.1`), MUST NOT set cookies, MUST NOT echo the request body in errors, and SHOULD support `OPTIONS /v1/events` preflight if it serves web emitters.

`Sources/StatsCloudflare/IngestDisposition.swift` is this table as a pure function of `(statusCode, headers)`.

## 8. Read contract ([§8](../docs/schema.md#8-read-contract))

Reads use a **separate** `X-Stats-Read-Key` that MUST NOT be embeddable in a shipped app; a write key MUST NOT grant reads (**401**). Read keys are project-scoped: `projectId` is validated against the scope, never trusted, and an out-of-scope project MUST return **401** without distinguishing "not authorized" from "no such project". Both endpoints are `GET`, return `application/json`, and MUST be safe and idempotent.

### 8.1 `GET /v1/summary?projectId=&from=&to=`

`from`/`to` are `YYYY-MM-DD` UTC and **inclusive**. `to` before `from` → **400**; `to` after today (UTC) MUST be **clamped to today**; a span over **400 days** → **400** with error `range_too_large`; a shorter span past retention MAY be clamped at the `from` end. The response's `from`/`to` echo what was actually served. `includeDebug` is `true`/`false`, default **`false`**.

```json
{
  "schema": "v1", "projectId": "overwatch",
  "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
  "rows": [
    { "date": "2026-08-01", "opens": 412, "sessions": 388, "activeInstalls": 96, "events": 5104 }
  ]
}
```

| Field | Definition |
|---|---|
| `date` | UTC calendar day of the event `ts` (never `sentAt`, never a local day). |
| `opens` | Count of `app_open` events that day; `0` if auto-events are off. |
| `sessions` | Distinct `sessionId`s with ≥ 1 event that day — **not additive** across days. |
| `activeInstalls` | Distinct `installId`s with ≥ 1 event that day — also not additive. |
| `events` | All events that day, auto-events included. |

Rows MUST exist for **every** day in the served range, ascending by `date`, empty days as explicit zeros. A range including today carries real counts so far — no zeros, no projection, and a backend MUST NOT flag the partial row. With `identity` denied the emitter uses per-session ephemeral install ids, so `activeInstalls` approaches `sessions`; a backend cannot detect this and MUST NOT try. A backend using approximate distinct counts MUST say so in its README, and readers MUST NOT present them as exact.

### 8.2 `GET /v1/events/top?projectId=&from=&to=[&name=][&limit=]`

`projectId`, `from`, `to`, `includeDebug` as §8.1. `name` is optional — an unknown name returns **200** with empty `rows`, not 404. `limit` is 1–100, default **20**; out of range or non-integer → **400**. Without `name` it caps total rows; with `name` it caps rows **per prop** (5 props at `limit=20` → up to 100 rows).

Without `name`, rows are `{ "name", "count", "installs" }` sorted by `count` descending then `name` ascending. With `name`, rows are `{ "prop", "value", "count", "installs" }` grouped by `prop` ascending, then `count` descending, then `value` ascending, with the `null` row last. The `null` row counts both explicit-`null` and absent props together, deliberately. Only `string`, `bool` and `null` props are broken down — numeric props MUST be omitted in `v1`. A backend MAY cap which props it breaks down and MUST document the cap.

### 8.3 Read errors

**400** malformed params · **401** missing/invalid/out-of-scope read key · **404** unknown path only · **429** with `Retry-After` · **5xx** backend fault. Retry 429/5xx with the §7 backoff; never retry 4xx. Bodies are `{"error": "<machine_code>", "message": "<human text>"}` with backend-defined but stable snake_case codes.

## 9. Identity ([§9](../docs/schema.md#9-identity))

`installId = lowercaseHex(SHA256(uuidString + salt))` — a random UUID v4 generated at first run, uppercase RFC 4122 form, concatenated with the app-supplied salt with no separator, UTF-8 encoded. The **raw UUID** is what is persisted and MUST NOT be transmitted.

Storage is the SDK's **own `UserDefaults` suite** (not `.standard`) — the only required-reason API the SDK touches (CA92.1). The identifier MUST NOT come from or be stored in the Keychain, `identifierForVendor`, the advertising identifier, a device serial, the MAC address, iCloud/CloudKit, or a shared app group; it therefore does not survive deletion and does not follow a user across apps or devices, deliberately. The salt prevents cross-app correlation of the same UUID; it is not a secret.

`reset()` MUST flush or discard pending events, generate a fresh UUID, reset `seq` to 0, clear any `userId`, and start a new session — events before and after MUST NOT be linkable. A backend MUST NOT create its own identifier (no IP-derived id, cookie, or fingerprint) and MUST NOT store client IPs alongside events.

## 10. Sessions ([§10](../docs/schema.md#10-session-policy))

A session begins on app launch (first `track()` after process start) and on the first activity after an inactivity gap — default **30 minutes on macOS**, **5 minutes on iOS/iPadOS**. The gap is measured from the last tracked event and evaluated when the next is tracked (no timer). Emitters MUST measure it on a **monotonic** clock, while `ts` and the session-id prefix come from the wall clock.

Session id: `<epochSeconds>-<8 random digits>`, e.g. `1786012978-40371852`, pattern `^[0-9]{10,}-[0-9]{8}$` — lexicographically sortable by start time. Ids are **not** globally unique; a backend MUST key sessions on `(installId, sessionId)`. A backend MUST NOT infer sessions, expire or re-window a session id, or reject an implausible `ts`; it SHOULD clamp an out-of-range `ts` into its retention window rather than drop the event.

## 11. Consent ([§11](../docs/schema.md#11-consent))

Opt-out by default, per app. The default SHOULD be `usage` + `diagnostics` and MUST NOT include `identity` (matching `StatsConsent.default`). A recorded `none` collects **nothing** — no queue file, no install id generated, no context sampled. The choice is persisted in the SDK's own UserDefaults suite and always wins over the configured default, which applies exactly once on first run.

| Group | Covers |
|---|---|
| `usage` | Event names, `props`, sessions, auto-events (§12). |
| `diagnostics` | The context object's diagnostic fields: os/device/arch/screen/locale/region, `isDebug`, `isTestFlight`, `colorScheme`. |
| `identity` | A stable `installId` across launches, and the `userId` field. Denied → a **per-session ephemeral** install id (fresh random UUID per session, hashed the same way) and `userId` omitted entirely. |

`usage` denied means nothing is emitted at all. `diagnostics` denied still sends a well-formed context with the §3 fallbacks; `sdkVersion`, `appVersion`, `appBuild` and `bundleId` are always sent. Revoking consent MUST discard (not flush) the queue and delete the stored install UUID, so re-granting starts a new identity — unlike an app's end-user opt-out master switch, which discards the queue but **keeps** the UUID. Consent is never on the wire: a backend receives only what consent permitted.

## 12. Reserved names and auto-events ([§12](../docs/schema.md#12-reserved-event-names))

Four reserved names, produced only by the emitter's **opt-in** auto-event flags (default off). An app MUST NOT emit them; an emitter MUST reject the attempt (log at `error`, drop the event).

| Name | Emitted when | Props |
|---|---|---|
| `app_open` | The app becomes active in the foreground, at most once per session start. | none |
| `app_background` | The app leaves the foreground; also the natural flush trigger. | none |
| `session_start` | A session begins; first event of that session. | none |
| `session_end` | Lazily when the *next* session begins, carrying the **previous** `sessionId` and a `ts` equal to that session's last event. A session that never resumes has none. | `duration_s` (whole seconds) |

Boundary ordering is fixed: `session_end` (old id) first, then `session_start` (new id), then `app_open` — so `session_end` carries the lower `seq` and an intentionally *older* `ts` than the preceding event. That is the one place in `v1` where `ts` is not monotonic with `seq`; a backend MUST NOT reject or reorder it, and MUST NOT infer session boundaries from `ts`.

The `stats_` prefix is reserved for future schema-level events; a backend MUST reject one with **400**.

## 13. Never collected ([§13](../docs/schema.md#13-deliberately-never-collected))

Out of scope for `v1` and MUST NOT be added: IP addresses (seen at the edge, never stored, logged beyond an ephemeral rate-limit counter, or turned into geography); location, timezone offset, GPS, Wi-Fi/SSID, cell info; IDFA/IDFV, serials, MAC or any hardware identifier; names, emails, usernames, phone numbers, contacts, calendar; user-typed free text — search queries, note bodies, file names and paths, document titles, URLs of user content; screen recordings, session replay, screenshots, view hierarchies, automatic screen-name capture; crash reports, stack traces or logs; purchase amounts, receipts, payment details; cross-app or cross-company joins, ad attribution, third-party audience export; any required-reason API beyond `UserDefaults` (CA92.1); third-party dependencies in the emitter.

Retention: a backend MUST document its raw-event retention, SHOULD keep raw events no longer than **90 days**, and MUST provide a way to delete all events for a given `installId` — the only per-person deletion this schema can support.

## 14. Privacy manifest ([§14](../docs/schema.md#14-privacy-manifest))

`Sources/Stats/Resources/PrivacyInfo.xcprivacy` MUST stay consistent with the schema: `NSPrivacyTracking` `false` with empty `NSPrivacyTrackingDomains`; collected types **Product Interaction** (names and `props`) and **Other Diagnostic Data** (the context object), both *not linked to identity* and *not used for tracking*, purposes App Functionality + Analytics; accessed API `NSPrivacyAccessedAPICategoryUserDefaults`, reason **CA92.1**.

It deliberately does **not** declare `NSPrivacyCollectedDataTypeUserID` — the SDK collects no account identifier on its own; an app calling `identify(userID:)` must add User ID to its own manifest and nutrition label. `StatsTests` asserts these values, so a contradicting manifest change fails CI. See [Contributing & Testing](Contributing-&-Testing).

## 15. Versioning ([§15](../docs/schema.md#15-versioning-this-document))

`v1` may gain **optional** fields and new enum values without changing the `schema` string — backends ignore unknown keys (§0) and accept unknown enum values where §3 says so. A breaking change (removing or renaming a field, tightening a limit, changing a §8.1 row definition) requires `v2`, a new `schema` value and a new path prefix (`/v2/events`); a backend SHOULD serve both side by side for at least one release cycle, and MUST reject a `schema` it does not implement with **400** rather than guessing. The schema version is independent of the SDK version: `Stats.schemaVersion` names the version a build speaks, `Stats.sdkVersion` the build.

_Last updated: 2026-08-19 — rewritten from docs/schema.md_
