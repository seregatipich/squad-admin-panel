import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/** Per-route budget for one client (IP + player), counted after authentication. */
export const ROUTE_RATE_LIMIT_MAX = 1200;
/**
 * Per-IP budget counted before authentication. Generous enough for several
 * admins behind one NAT with polling pages open; it exists to bound the
 * session/token lookups anonymous traffic can force, not to shape real use.
 */
export const PRE_AUTH_RATE_LIMIT_MAX = 3000;
const RATE_LIMIT_WINDOW = '1 minute';

export interface RateLimitOptions {
  /** Overrides {@link PRE_AUTH_RATE_LIMIT_MAX}; used by tests. */
  preAuthMax?: number;
}

/**
 * Registers the API's two request limiters. Must run before `authPlugin`.
 *
 * `@fastify/rate-limit` attaches its default limiter as a route-level
 * `onRequest` hook, and Fastify runs route-level hooks after the global ones.
 * The global auth hook answers 401 itself, so an unauthenticated request never
 * reaches that limiter — yet it already cost a Redis GET plus a Postgres
 * SELECT for its cookie or bearer token (#1234). A second, instance-level hook
 * registered here, ahead of the auth hook, counts every request per client IP
 * and answers 429 before any credential lookup.
 *
 * The pre-auth check goes through `createRateLimit`, which does not mark the
 * request as limited, so the per-route limiter (keyed by IP and player) still
 * applies to authenticated traffic. Both stores are in-process; the panel runs
 * a single API instance.
 *
 * @param app - Root Fastify instance.
 * @param opts - Limit overrides.
 */
export async function registerRateLimits(
  app: FastifyInstance,
  opts: RateLimitOptions = {},
): Promise<void> {
  await app.register(rateLimit, {
    max: ROUTE_RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    keyGenerator: (req) => `${req.ip}:${req.user?.playerId ?? ''}`,
  });
  const preAuthLimit = app.createRateLimit({
    max: opts.preAuthMax ?? PRE_AUTH_RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    keyGenerator: (req) => req.ip,
  });
  app.addHook('onRequest', async (req, reply) => {
    const result = await preAuthLimit(req);
    if (result.isAllowed || !result.isExceeded) return;
    reply
      .code(429)
      .header('retry-after', String(result.ttlInSeconds))
      .send({ error: 'rate_limited', retry_after_s: result.ttlInSeconds });
  });
}
