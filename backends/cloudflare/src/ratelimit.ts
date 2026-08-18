// Per-isolate best-effort rate limiting.
//
// WHAT THIS IS NOT: the durable limit. A Worker isolate is one of many, it is
// recycled at will, and its `Map` is not shared with anything — so a client that
// spreads its requests across isolates sees a multiple of the numbers below. The
// durable, global limit is a **Cloudflare Rate Limiting rule** in front of the
// Worker, shipped as documented config in backends/cloudflare/README.md
// ("Rate limiting"). This module is the cheap in-Worker backstop that costs no
// storage read, and — importantly — the thing that lets §8.3's 429 be emitted at
// all on the read endpoints, which previously had no limiter of any kind.
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
 * Pre-auth ceiling per presented key per minute.
 *
 * Set well above what a conforming client can produce: §7 allows an emitter at
 * most one ingest request in flight, and a reader polls a dashboard. It is high
 * enough that no honest client trips it and low enough to blunt a loop.
 */
export const PRE_AUTH_LIMIT_PER_WINDOW = 600;

/**
 * Post-auth ceiling per project per minute on ingest. Distinct from the above so
 * that many keys minted for one project cannot together exceed the project's
 * share by minting more keys.
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
export async function checkPreAuthRate(presentedKey: string | null, now: number): Promise<void> {
  // A key shape that cannot be valid does not deserve a SHA-256 either; it goes
  // in the anonymous bucket with the missing-key requests. Mirrors the length
  // gate in `resolveKey`, so the two cannot disagree about what is worth hashing.
  if (presentedKey === null || presentedKey.length < 8 || presentedKey.length > 256) {
    countAgainst('anonymous', now, PRE_AUTH_LIMIT_PER_WINDOW);
    return;
  }
  const hash = await hashKey(presentedKey);
  countAgainst(`key:${hash}`, now, PRE_AUTH_LIMIT_PER_WINDOW);
}

/** The post-auth ingest limiter, keyed on the project the write key resolved to. */
export function checkProjectRate(projectId: string, now: number): void {
  countAgainst(`project:${projectId}`, now, INGEST_LIMIT_PER_WINDOW);
}

/** Test seam: forget every bucket. Not called by the Worker. */
export function resetRateLimiter(): void {
  buckets.clear();
}
