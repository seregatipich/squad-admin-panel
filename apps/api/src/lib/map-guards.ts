import type { DatabaseClient } from '@squad/db';
import type { SquadPermissionKey } from '@squad/shared-config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { writeAuditEntry } from './audit.js';

/**
 * #308: `requireChangemap` was duplicated verbatim between server-map.ts and
 * server-map-vote.ts, and `auditMapAction`/`auditMapVoteWrite`/
 * `auditMessagingAction` were three identical wrappers over
 * `writeAuditEntry`. Both live here so the three route modules share one
 * copy each, instead of a change to the auth or audit shape needing to be
 * repeated (and easily missed) in every route file.
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

/**
 * Writes an audit_log entry for the current user's action against a server
 * resource, in the shape server-map.ts, server-map-vote.ts and
 * server-messaging.ts all used identically.
 */
export async function auditMapLikeAction(
  db: DatabaseClient,
  req: FastifyRequest,
  reply: FastifyReply,
  input: { actionType: string; serverId: string; after: unknown },
): Promise<void> {
  if (!req.user) return;
  await writeAuditEntry(db, {
    actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
    actorIp: req.ip ?? null,
    actionType: input.actionType,
    targetType: 'server',
    targetId: input.serverId,
    after: input.after,
    context: { requestId: req.id, method: req.method, url: req.url },
    statusCode: reply.statusCode,
  });
}
