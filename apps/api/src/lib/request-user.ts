import type { FastifyRequest } from 'fastify';

/** The caller identity the auth plugin attaches to an authenticated request. */
export type RequestUser = NonNullable<FastifyRequest['user']>;

/**
 * Returns the authenticated caller of a non-public route.
 *
 * The fail-closed `onRequest` hook in `plugins/auth.ts` (#246) already answers
 * 401 for every route without `config.public: true` before the handler runs,
 * so a handler-level `if (!req.user) → 401` branch is unreachable. This helper
 * only narrows the type; reaching the throw means the route was declared
 * `public` or the hook order changed, and a 500 is the correct loud failure.
 *
 * @param req - a request to a route that does not declare `config.public`.
 * @returns the caller attached by the auth hook.
 * @throws Error when no user is attached (a wiring bug, never user input).
 */
export function requestUser(req: FastifyRequest): RequestUser {
  if (!req.user) {
    throw new Error(`requestUser() on ${req.method} ${req.url} without an authenticated caller`);
  }
  return req.user;
}
