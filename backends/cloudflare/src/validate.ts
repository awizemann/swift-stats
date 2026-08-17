// Envelope / event / context validation, straight off docs/schema.md §0–§5.
//
// Two policies this backend commits to, both of which §2.3 and
// backends/README.md require it to state explicitly:
//
//  * props SIZE limits (key count, key length, string value length) are handled
//    by TRUNCATING AND DROPPING, not by rejecting. §2.3 says a conforming
//    backend SHOULD do this so an emitter bug degrades a property instead of
//    losing a day of data. The surviving 32 keys are the first 32 in the
//    byte-wise ascending key order of §0, which is the same choice the emitter
//    makes — so emitter and backend keep the same 32.
//  * A props value of a DISALLOWED TYPE (object or array) is always 400, with no
//    coercion, because coercing would silently invent a value (§2.3).
//
// Unknown keys on the envelope, event and context are IGNORED, never rejected
// (§0) — that is how v1 grows. That leniency stops at `props`, where every key
// is app-authored and §2.3 is the whole story.

import { badRequest, HttpError } from './errors.js';
import { isValidTimestamp } from './dates.js';

export const SCHEMA_VERSION = 'v1';
export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_BODY_BYTES = 262_144; // 256 KiB uncompressed (§5)
export const MAX_PROPS_KEYS = 32;
export const MAX_PROP_KEY_SCALARS = 40;
export const MAX_PROP_VALUE_SCALARS = 200;

const EVENT_NAME_RE = /^[a-z][a-z0-9_]*$/;
const PROP_KEY_RE = /^[a-z][a-z0-9_]*$/;
const PROJECT_ID_RE = /^[A-Za-z0-9._-]+$/;
const INSTALL_ID_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[0-9]{10,}-[0-9]{8}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Names produced only by the emitter's auto-event flags (§12). */
export const RESERVED_EVENT_NAMES = new Set([
  'app_open',
  'app_background',
  'session_start',
  'session_end',
]);

/**
 * Lengths are counted in UNICODE SCALARS (§0) — not UTF-16 code units and not
 * grapheme clusters — so that a JS and a Swift emitter agree. `s.length` would
 * count an emoji outside the BMP as 2; the spread counts it as 1, matching
 * Swift's `String.unicodeScalars.count`.
 */
export function scalarCount(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Truncate to `max` unicode scalars without splitting a surrogate pair. */
function truncateScalars(s: string, max: number): string {
  let n = 0;
  let out = '';
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n += 1;
  }
  return out;
}

export type PropValue = string | number | boolean | null;

export interface ValidatedEvent {
  readonly name: string;
  readonly ts: string;
  readonly sessionId: string;
  readonly installId: string;
  readonly appId: string;
  readonly seq: number;
  readonly userId: string | null;
  /** Null when absent or empty after §2.3 pruning; otherwise a flat map. */
  readonly props: Record<string, PropValue> | null;
}

export interface ValidatedContext {
  readonly sdkVersion: string;
  readonly appVersion: string;
  readonly appBuild: string;
  readonly bundleId: string;
  readonly osName: string;
  readonly osVersion: string;
  readonly deviceModel: string;
  readonly arch: string;
  readonly locale: string;
  readonly region: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly screenScale: number;
  readonly isDebug: boolean;
  readonly isTestFlight: boolean;
  readonly colorScheme: string | null;
}

export interface ValidatedBatch {
  /** Uppercased before use as a dedupe key (§1, §6). */
  readonly batchId: string;
  readonly sentAt: string;
  readonly context: ValidatedContext;
  readonly events: readonly ValidatedEvent[];
  /** The client-asserted projectId, if any. Validated against the key, never stored. */
  readonly assertedProjectId: string | null;
  /** Count of props adjustments made under §2.3. Logged, never fatal. */
  readonly propsAdjustments: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** §0: an optional field MAY be omitted or `null`; the two are equivalent. */
function absent(v: unknown): boolean {
  return v === undefined || v === null;
}

function reqString(v: unknown, field: string, maxScalars?: number): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw badRequest('invalid_envelope', `Field \`${field}\` must be a non-empty string.`);
  }
  if (maxScalars !== undefined && scalarCount(v) > maxScalars) {
    throw badRequest('invalid_envelope', `Field \`${field}\` exceeds ${maxScalars} scalars.`);
  }
  return v;
}

function reqInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw badRequest('invalid_context', `Field \`${field}\` must be an integer.`);
  }
  return v;
}

function reqFinite(v: unknown, field: string): number {
  // §0: numbers MUST be finite. JSON.parse cannot produce NaN/Infinity from
  // valid JSON, but it can from `1e999` (which parses to Infinity), so this is
  // a real check, not a formality.
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw badRequest('invalid_context', `Field \`${field}\` must be a finite number.`);
  }
  return v;
}

function reqBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') {
    throw badRequest('invalid_context', `Field \`${field}\` must be a boolean.`);
  }
  return v;
}

/**
 * §2.3. Returns the pruned props plus the number of adjustments made.
 *
 * Order matters: a non-conforming KEY is dropped before the 32-key cap is
 * applied, so a batch with 33 keys of which one is malformed keeps 32 good ones
 * rather than 31.
 */
function validateProps(
  raw: unknown,
  eventIndex: number,
): { props: Record<string, PropValue> | null; adjustments: number } {
  if (absent(raw)) return { props: null, adjustments: 0 };
  if (!isPlainObject(raw)) {
    throw badRequest('invalid_event', `Event ${eventIndex}: \`props\` must be an object.`);
  }

  let adjustments = 0;
  const kept: Array<[string, PropValue]> = [];

  // §0 byte-wise ascending over UTF-8 bytes. JS `sort()` on strings compares
  // UTF-16 code units, which disagrees with UTF-8 byte order for astral-plane
  // characters (a U+FFFD-range BMP char sorts after a surrogate pair in UTF-16
  // but before it in UTF-8). Props keys are constrained to [a-z0-9_] so the two
  // orders coincide for CONFORMING keys — but we sort before we know a key
  // conforms, so compare actual UTF-8 bytes and stay correct either way.
  const encoder = new TextEncoder();
  const entries = Object.entries(raw).sort((a, b) => {
    const ab = encoder.encode(a[0]);
    const bb = encoder.encode(b[0]);
    const n = Math.min(ab.length, bb.length);
    for (let i = 0; i < n; i += 1) {
      const d = (ab[i] as number) - (bb[i] as number);
      if (d !== 0) return d;
    }
    return ab.length - bb.length;
  });

  for (const [key, value] of entries) {
    // A disallowed value TYPE is 400 and is checked FIRST — before the key
    // pattern and before the 32-key cap. §2.3 makes this unconditional: it is
    // not a size limit, so there is no truncate-or-reject choice to make, and
    // it must not be masked by the key having also been droppable.
    if (isPlainObject(value) || Array.isArray(value)) {
      throw badRequest(
        'invalid_event',
        `Event ${eventIndex}: props value for a key is an object or array, which \`v1\` forbids.`,
      );
    }

    if (!PROP_KEY_RE.test(key) || scalarCount(key) > MAX_PROP_KEY_SCALARS) {
      adjustments += 1;
      continue;
    }

    let coerced: PropValue;
    if (typeof value === 'string') {
      if (scalarCount(value) > MAX_PROP_VALUE_SCALARS) {
        coerced = truncateScalars(value, MAX_PROP_VALUE_SCALARS);
        adjustments += 1;
      } else {
        coerced = value;
      }
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        adjustments += 1;
        continue;
      }
      coerced = value;
    } else if (typeof value === 'boolean' || value === null) {
      coerced = value;
    } else {
      // `undefined`, a function, a symbol — not reachable from JSON.parse, but
      // reachable if this is ever called on a hand-built object.
      adjustments += 1;
      continue;
    }

    if (kept.length >= MAX_PROPS_KEYS) {
      adjustments += 1;
      continue;
    }
    kept.push([key, coerced]);
  }

  if (kept.length === 0) return { props: null, adjustments };
  return { props: Object.fromEntries(kept), adjustments };
}

function validateContext(raw: unknown): ValidatedContext {
  if (!isPlainObject(raw)) {
    throw badRequest('invalid_context', 'Field `context` must be an object.');
  }
  return {
    sdkVersion: reqString(raw.sdkVersion, 'context.sdkVersion', 32),
    appVersion: reqString(raw.appVersion, 'context.appVersion', 32),
    appBuild: reqString(raw.appBuild, 'context.appBuild', 32),
    bundleId: reqString(raw.bundleId, 'context.bundleId', 128),
    // §3: an unknown `osName` / `arch` MUST be accepted and stored VERBATIM, so
    // a new Apple platform (or the reserved `web` / `wasm32`) needs no schema
    // bump. Length is still bounded so a hostile client cannot store a novel.
    osName: reqString(raw.osName, 'context.osName', 32),
    osVersion: reqString(raw.osVersion, 'context.osVersion', 32),
    deviceModel: reqString(raw.deviceModel, 'context.deviceModel', 64),
    arch: reqString(raw.arch, 'context.arch', 32),
    locale: reqString(raw.locale, 'context.locale', 32),
    region: reqString(raw.region, 'context.region', 8),
    // The consent-reduced fallbacks of §3 (osVersion "15", deviceModel
    // "unknown", locale "en", region "ZZ", screen 0/0/1.0) all satisfy the
    // checks above and below. That is deliberate: §3 says a backend MUST accept
    // them, so there is no stricter shape check on these fields to accept them
    // *past*.
    screenWidth: reqInt(raw.screenWidth, 'context.screenWidth'),
    screenHeight: reqInt(raw.screenHeight, 'context.screenHeight'),
    screenScale: reqFinite(raw.screenScale, 'context.screenScale'),
    isDebug: reqBool(raw.isDebug, 'context.isDebug'),
    isTestFlight: reqBool(raw.isTestFlight, 'context.isTestFlight'),
    colorScheme: absent(raw.colorScheme)
      ? null
      : reqString(raw.colorScheme, 'context.colorScheme', 16),
  };
}

function validateEvent(raw: unknown, index: number): {
  event: ValidatedEvent;
  assertedProjectId: string | null;
  adjustments: number;
} {
  if (!isPlainObject(raw)) {
    throw badRequest('invalid_event', `Event ${index} must be an object.`);
  }

  const name = reqString(raw.name, `events[${index}].name`, 64);
  // The `stats_` prefix check comes first so a name like `stats_foo` gets the
  // specific code rather than being reported as a generic bad name.
  if (name.startsWith('stats_')) {
    throw badRequest(
      'reserved_event_name',
      `Event ${index}: the \`stats_\` prefix is reserved by the schema.`,
    );
  }
  if (!EVENT_NAME_RE.test(name)) {
    throw badRequest(
      'invalid_event',
      `Event ${index}: \`name\` must match ^[a-z][a-z0-9_]*$ and be 1–64 scalars.`,
    );
  }

  const ts = reqString(raw.ts, `events[${index}].ts`);
  if (!isValidTimestamp(ts)) {
    throw badRequest(
      'invalid_event',
      `Event ${index}: \`ts\` must be ISO 8601 UTC with millisecond precision and a literal Z.`,
    );
  }

  const sessionId = reqString(raw.sessionId, `events[${index}].sessionId`);
  if (!SESSION_ID_RE.test(sessionId)) {
    throw badRequest('invalid_event', `Event ${index}: \`sessionId\` must match ^[0-9]{10,}-[0-9]{8}$.`);
  }

  const installId = reqString(raw.installId, `events[${index}].installId`);
  if (!INSTALL_ID_RE.test(installId)) {
    throw badRequest('invalid_event', `Event ${index}: \`installId\` must be 64 lowercase hex chars.`);
  }

  const appId = reqString(raw.appId, `events[${index}].appId`, 128);

  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) {
    throw badRequest('invalid_event', `Event ${index}: \`seq\` must be a non-negative integer.`);
  }
  const seq = raw.seq;

  let assertedProjectId: string | null = null;
  if (!absent(raw.projectId)) {
    const p = reqString(raw.projectId, `events[${index}].projectId`, 64);
    if (!PROJECT_ID_RE.test(p)) {
      throw badRequest('invalid_event', `Event ${index}: \`projectId\` may only contain [A-Za-z0-9._-].`);
    }
    assertedProjectId = p;
  }

  const userId = absent(raw.userId) ? null : reqString(raw.userId, `events[${index}].userId`, 128);

  const { props, adjustments } = validateProps(raw.props, index);

  return {
    event: { name, ts, sessionId, installId, appId, seq, userId, props },
    assertedProjectId,
    adjustments,
  };
}

/**
 * Validate one ingest body. Throws `HttpError` (400) on any violation; §7 makes
 * a 400 a permanent drop, so every throw here must be a condition that would
 * never become valid on retry.
 */
export function validateBatch(body: unknown): ValidatedBatch {
  if (!isPlainObject(body)) {
    throw badRequest('invalid_envelope', 'Body must be a single JSON object.');
  }

  if (body.schema !== SCHEMA_VERSION) {
    // §15: reject a schema value we do not implement rather than guessing.
    throw badRequest('bad_schema_version', `Unsupported \`schema\`; this backend serves "v1" only.`);
  }

  const batchIdRaw = reqString(body.batchId, 'batchId', 36);
  if (!UUID_RE.test(batchIdRaw)) {
    throw badRequest('invalid_envelope', 'Field `batchId` must be an RFC 4122 UUID.');
  }
  // §1: accept either case, uppercase before using as the dedupe key. Without
  // this, the same batch retried by a lowercase-emitting emitter would insert
  // twice.
  const batchId = batchIdRaw.toUpperCase();

  const sentAt = reqString(body.sentAt, 'sentAt');
  if (!isValidTimestamp(sentAt)) {
    throw badRequest('invalid_envelope', 'Field `sentAt` must be ISO 8601 UTC with millisecond precision.');
  }

  const context = validateContext(body.context);

  if (!Array.isArray(body.events)) {
    throw badRequest('invalid_envelope', 'Field `events` must be an array.');
  }
  if (body.events.length === 0) {
    throw badRequest('empty_events', 'Field `events` must contain at least one event.');
  }
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    throw badRequest('too_many_events', `A batch may contain at most ${MAX_EVENTS_PER_BATCH} events.`);
  }

  const events: ValidatedEvent[] = [];
  let assertedProjectId: string | null = null;
  let propsAdjustments = 0;

  for (let i = 0; i < body.events.length; i += 1) {
    const parsed = validateEvent(body.events[i], i);
    propsAdjustments += parsed.adjustments;

    // §1: one (appId, installId) pair per batch, and at most one projectId. The
    // single `context` and the §7 key-scope check are only unambiguous if this
    // holds, so a mixed batch is 400 rather than a best-effort split.
    const first = events[0];
    if (first !== undefined) {
      if (parsed.event.appId !== first.appId) {
        throw badRequest('mixed_batch', 'A batch must not mix `appId` values.');
      }
      if (parsed.event.installId !== first.installId) {
        throw badRequest('mixed_batch', 'A batch must not mix `installId` values.');
      }
    }
    if (parsed.assertedProjectId !== null) {
      if (assertedProjectId !== null && parsed.assertedProjectId !== assertedProjectId) {
        throw badRequest('mixed_batch', 'A batch must not mix `projectId` values.');
      }
      assertedProjectId = parsed.assertedProjectId;
    }

    // §3: `bundleId` MUST equal each event's `appId`; §0 makes a mismatch a 400.
    if (parsed.event.appId !== context.bundleId) {
      throw badRequest(
        'invalid_event',
        `Event ${i}: \`appId\` must equal \`context.bundleId\`.`,
      );
    }

    // Note what is deliberately NOT checked here, because §1/§2.2/§12 forbid it:
    //  * more than one `sessionId` in a batch — legal, a batch spans boundaries.
    //  * `seq` ordering — SHOULD be ascending; we MUST NOT rely on or reject it.
    //  * a `session_end` whose `ts` is older than a lower-`seq` event's `ts`.
    //  * a future-dated or very old `ts` — tolerated, clamped at bucket time.
    //  * a RESERVED name — reserved against the *emitter*, not the backend; the
    //    emitter's auto-events legitimately carry them and we must store them.
    events.push(parsed.event);
  }

  return { batchId, sentAt, context, events, assertedProjectId, propsAdjustments };
}

/** Parse a body that has already passed the byte cap. Malformed JSON → 400. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('bad_json', 'Body is not valid JSON.');
  }
}

export { HttpError };
