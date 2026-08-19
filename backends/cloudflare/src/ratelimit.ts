// Per-isolate best-effort rate limiting.
//
// ADVISORY, NOT GLOBAL. Read this before you quote any number below as a limit.
//
// The counters live in a module-scope `Map` inside ONE Worker isolate. Cloudflare
// runs many isolates per colo and many colos, and recycles an isolate whenever it
// likes, so:
//
//   * the effective global ceiling is (this number) x (however many isolates
//     happen to be serving that client right now) — an unknown, time-varying
//     multiple, never the number written here;
//   * an isolate eviction resets the window to zero;
//   * two requests one second apart may be counted by different isolates and so
//     not counted together at all.
//
// Nothing may depend on this being exact. It is a backstop that makes a runaway
// client cheap to refuse without a storage read; the DURABLE limit is the
// Cloudflare Rate Limiting rule in front of the Worker (README, "Rate limiting"),
// and ADOPTION.md discusses making it global inside the Worker instead.
//
// What it IS: the cheap in-Worker backstop that costs no storage read, and the
// thing that lets §8.3's 429 be emitted at all on the read endpoints, which
// previously had no limiter of any kind.
//
// THE BUCKET KEY IS NEVER THE IP. §13 forbids storing or logging the client IP or
// anything derived from it, and a `Map` keyed on `CF-Connecting-IP` is exactly
// that — it is storage, it is just short-lived. The key is instead the SHA-256 of
// the presented API key, which is:
//
//   * available BEFORE authentication, so an unknown or revoked key is limited
//     without first costing a D1 read (the whole point of running pre-auth),
//   * already what `keys.key_hash` stores, so it reveals nothing new,
//   * per-client in the way that matters — one project's key, one bucket.
//
// A request with no key at all shares one `anonymous` bucket. That is deliberate:
// those requests are 401s, they should be cheap to refuse, and the alternative
// (not limiting them) leaves the unauthenticated path unbounded.

import { rateLimited } from './errors.js';
import { hashKey } from './keys.js';

/** Window length for every bucket below. */
export const RATE_WINDOW_MS = 60_000;

/**
 * Pre-auth ceiling per presented key per minute, on the INGEST path.
 *
 * Deliberately NOT lowered, and the reason is worth writing down: on ingest the
 * key bucket is a whole FLEET, not one client. Every install of an app presents
 * the same write key (§7 — it ships in the binary), so this bucket counts every
 * device of every user of that app that this isolate happens to serve. A number
 * chosen as if it were per-device would 429 a popular app's honest traffic.
 *
 * The failure mode of being too low is bounded but real: §7 makes a 429 RETAIN,
 * so no data is lost — but every 429 becomes a retry, and a limit a healthy fleet
 * trips continuously converts steady traffic into a backlog that never drains.
 * Being too high costs only that an abusive caller gets more cheap 401s per
 * minute out of one isolate, which is the side to err on.
 */
export const PRE_AUTH_LIMIT_PER_WINDOW = 600;

/**
 * Pre-auth ceiling per presented READ key per minute.
 *
 * Much tighter than the ingest number, because the population is different: a
 * read key is one dashboard or one script (§8 forbids embedding it in a shipped
 * app), not a fleet. 120/min is two requests a second sustained — far above any
 * dashboard's polling and far below anything worth calling a scrape. It matches
 * the read rule the README's WAF config uses, so the in-Worker backstop and the
 * durable limit do not disagree about what "too many" means.
 *
 * A read 429 is only a delay for a human at a dashboard; unlike ingest there is
 * no queue behind it that a false positive can back up.
 */
export const READ_LIMIT_PER_WINDOW = 120;

/**
 * Post-auth ceiling per project per minute on ingest. Distinct from the above so
 * that many keys minted for one project cannot together exceed the project's
 * share by minting more keys. Equal to, not below, the per-key number for the
 * same reason that one is what it is: the population is a fleet.
 */
export const INGEST_LIMIT_PER_WINDOW = 600;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Count one request against `bucketKey`, throwing 429 with `Retry-After` past
 * the limit (§7 for ingest, §8.3 for the read endpoints).
 *
 * Exported for tests, which need to drive it without a hundred real requests.
 */
export function countAgainst(bucketKey: string, now: number, limit: number): void {
  const bucket = buckets.get(bucketKey);
  if (bucket === undefined || now >= bucket.resetAt) {
    buckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // Opportunistic sweep of expired buckets, so a Worker that has seen many
    // distinct keys does not hold them all until it is recycled. Bounded work:
    // only on the miss path, and only when the map has grown.
    if (buckets.size > 4_096) {
      for (const [key, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(key);
      }
    }
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw rateLimited(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
  }
}

/**
 * The pre-auth limiter. Call this BEFORE `resolveKey`, on every authenticated
 * endpoint.
 *
 * Ordering matters: run after `resolveKey` and a key-guessing loop gets a free D1
 * read per attempt, which is the expensive half of the request and the half an
 * attacker cares about making us do.
 */
export async function checkPreAuthRate(
  presentedKey: string | null,
  now: number,
  /** Per-endpoint ceiling; the read endpoints pass `READ_LIMIT_PER_WINDOW`. */
  limit: number = PRE_AUTH_LIMIT_PER_WINDOW,
): Promise<void> {
  // A key shape that cannot be valid does not deserve a SHA-256 either; it goes
  // in the anonymous bucket with the missing-key requests. Mirrors the length
  // gate in `resolveKey`, so the two cannot disagree about what is worth hashing.
  //
  // The anonymous bucket keeps the INGEST ceiling even on a read endpoint: it is
  // shared by every keyless request to every path, so charging it the tighter
  // read number would let keyless noise on `/v1/summary` starve keyless requests
  // elsewhere. It is a DoS backstop, not a per-client quota — nothing legitimate
  // lands in it, since every request without a usable key is a 401.
  if (presentedKey === null || presentedKey.length < 8 || presentedKey.length > 256) {
    countAgainst('anonymous', now, PRE_AUTH_LIMIT_PER_WINDOW);
    return;
  }
  const hash = await hashKey(presentedKey);
  countAgainst(`key:${hash}`, now, limit);
}

/** The post-auth ingest limiter, keyed on the project the write key resolved to. */
export function checkProjectRate(projectId: string, now: number): void {
  countAgainst(`project:${projectId}`, now, INGEST_LIMIT_PER_WINDOW);
}

/** Test seam: forget every bucket. Not called by the Worker. */
export function resetRateLimiter(): void {
  buckets.clear();
}
