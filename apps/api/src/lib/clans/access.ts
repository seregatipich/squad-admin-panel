import type { ClanRow } from '@squad/db/schema';
import { clanMembers, clans } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Binds the clan lookups to one Fastify instance's database.
 *
 * @param app - The instance whose `db` decoration the lookups query.
 * @returns `loadActiveClan` (a non-deleted clan row or `null`), `membershipRole`
 *   (the player's role in the clan or `null`) and `clanManageLevel` (`full` for
 *   a clan-manager or the leader, `deputy` for a deputy, `null` otherwise).
 */
export function clanAccess(app: FastifyInstance) {
  async function loadActiveClan(id: string): Promise<ClanRow | null> {
    const rows = await app.db
      .select()
      .from(clans)
      .where(and(eq(clans.id, id), isNull(clans.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function membershipRole(clanId: string, playerId: string): Promise<string | null> {
    const rows = await app.db
      .select({ role: clanMembers.memberRole })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clanId), eq(clanMembers.playerId, playerId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  async function clanManageLevel(
    clanId: string,
    user: NonNullable<FastifyRequest['user']>,
  ): Promise<'full' | 'deputy' | null> {
    if (user.permissions.canManageClans) return 'full';
    const role = await membershipRole(clanId, user.playerId);
    if (role === 'leader') return 'full';
    if (role === 'deputy') return 'deputy';
    return null;
  }

  return { loadActiveClan, membershipRole, clanManageLevel };
}
