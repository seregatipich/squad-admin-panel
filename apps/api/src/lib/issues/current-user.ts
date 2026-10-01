/** Caller gate of the issue tracker routes. */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Resolves the caller for the tracker routes, answering 401 without a user
 * and 403 without `panel_access` (#7). The tracker is a panel surface:
 * authentication alone let a session minted before the player's panel access
 * was withdrawn keep reading and writing it. API tokens arrive already
 * narrowed by `narrowToTokenScopes`, so a `scopes: []` token is refused here
 * and no token ever carries `canManageIssues`.
 *
 * @returns The authenticated panel user, or `null` once a reply was sent.
 */
export function currentUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return req.user;
}
