// stats-worker — the Cloudflare/D1 backend for swift-stats.
//
// Contract: ../../docs/schema.md (wire schema v1). Three endpoints and one cron:
//
//   POST /v1/events        ingest,  X-Stats-Key       (write key)  -> 202
//   GET  /v1/summary       read,    X-Stats-Read-Key  (read key)
//   GET  /v1/events/top    read,    X-Stats-Read-Key  (read key)
//   cron                   roll up yesterday, then age out raw events past 90 days
//
// Deliberately absent: cookies, redirects, CORS, any storage of the client IP or
// anything derived from it, and any identifier of the Worker's own invention
// (§9, §13). If you are adding a header or a column, check §13 first.

import { HttpError, internalError, methodNotAllowed, notFound } from './errors.js';
import { handleIngest } from './ingest.js';
import { handleSummary, handleTopEvents } from './read.js';
import { runScheduled } from './rollup.js';
import { logger } from './log.js';
import type { Env } from './env.js';

async function route(request: Request, env: Env, now: Date): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  // HEAD is handled by the runtime for GET routes; it is not enumerated here.
  switch (pathname) {
    case '/v1/events':
      if (method !== 'POST') throw methodNotAllowed('POST');
      return await handleIngest(request, env, now);

    case '/v1/summary':
      // §8: both read endpoints MUST be safe and idempotent, which is why only
      // GET reaches them — a POST to a read path is a 405, not a lenient alias.
      if (method !== 'GET') throw methodNotAllowed('GET');
      return await handleSummary(request, env, now);

    case '/v1/events/top':
      if (method !== 'GET') throw methodNotAllowed('GET');
      return await handleTopEvents(request, env, now);

    case '/health':
      // No auth and no D1 read: this is for a uptime check, so it must not be
      // able to fail for a reason unrelated to the Worker being up.
      return new Response(JSON.stringify({ ok: true, schema: 'v1' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });

    default:
      // §8.3: 404 for an unknown PATH only. Never for an unknown project, an
      // unknown event name, or an empty result — those are 401 and 200
      // respectively, and conflating them leaks which projects exist.
      throw notFound();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const now = new Date();
    try {
      return await route(request, env, now);
    } catch (cause) {
      // Several rejections happen deliberately BEFORE the body is read — a bad
      // Content-Type, a compressed body, an unknown key — so that an
      // unauthenticated or obviously-wrong caller never gets us to read 256 KiB.
      // That leaves the request body stream unread, so cancel it explicitly
      // rather than leaving a dangling stream for the runtime to tear down.
      if (request.body !== null && !request.bodyUsed) {
        await request.body.cancel().catch(() => {});
      }

      if (cause instanceof HttpError) {
        // The body is never echoed (§7) — `HttpError` messages are our own
        // literals, and `toResponse` serializes only `error` and `message`.
        return cause.toResponse();
      }
      // An unexpected throw becomes a 500, which §7 makes RETAIN-and-retry for
      // the emitter. Never let it become a 4xx: that would be a permanent drop
      // of a batch that was fine.
      logger.error('unhandled', { path: new URL(request.url).pathname }, cause);
      return internalError().toResponse();
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // `waitUntil` so the invocation is not cut short mid-rollup. The job is
    // idempotent, so a retry of a partial run is safe.
    ctx.waitUntil(
      runScheduled(env, new Date()).then(
        (r) => logger.info('scheduled_done', { rows: r.rolled.length, events: r.deletedEvents }),
        (cause) => logger.error('scheduled_failed', {}, cause),
      ),
    );
  },
};
