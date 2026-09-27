import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Authorises a read of one player's combat numbers (kills, deaths, K/D,
 * teamkills, weapons, vehicles).
 *
 * A caller always sees their own player's numbers: `combat_view` hides other
 * players' combat stats, not one's own, and the «Аккаунт» page relies on it.
 * Everyone else needs the role's `combatView` flag, which API tokens never
 * carry (see `narrowToTokenScopes`). Routes using this guard still declare
 * `config.permissions` so the global hook applies the token's scopes first.
 *
 * Shared by `/dossier`, `/combat-summary`, `/weapon-stats` and `/vehicle-stats`
 * so the same data cannot be read through a less guarded route (#40, #215).
 *
 * @param req - The request; `req.user` is set by the auth plugin.
 * @param reply - The reply; its status code is set on denial.
 * @param subjectPlayerId - The player whose combat numbers are requested.
 * @returns An error body to return (401/403 already set), or null when allowed.
 */
export function combatGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  subjectPlayerId: string,
): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (req.user.playerId === subjectPlayerId) return null;
  if (!req.user.permissions.combatView) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}
