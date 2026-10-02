import type { SquadPermissionKey } from '@squad/shared-config';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * #308: `requireChangemap` was duplicated verbatim between server-map.ts and
 * server-map-vote.ts. It lives here so both route modules share one copy,
 * instead of a change to the auth shape needing to be repeated (and easily
 * missed) in every route file.
 */
export function requireSquadPermission(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: SquadPermissionKey,
): { error: string; required_squad_permission?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.squadPermissions.has(permission)) {
    reply.code(403);
    return { error: 'forbidden', required_squad_permission: permission };
  }
  return null;
}
