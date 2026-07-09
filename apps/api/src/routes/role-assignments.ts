import { players, roles } from '@squad/db/schema';
import { and, asc, eq, isNotNull, lte, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * VIP/role registry (VIPSUB-2, issue #168): a read-only roster of every
 * player that currently holds a role, joined with the role badge so the
 * `/vips` panel page can render who has elevated access, until when, and
 * why — without walking the full `/roles/:id/members` list per role.
 */
const listQuery = z.object({
  role_id: z.string().uuid().optional(),
  // 'true' narrows the roster to time-limited grants expiring within the
  // next EXPIRING_SOON_WINDOW_MS (permanent assignments have a null
  // role_expires_at and are never "expiring soon").
  expiring_soon: z.enum(['true', 'false']).optional(),
});

const EXPIRING_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const roleAssignmentsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/role-assignments',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req) => {
      const conditions: SQL[] = [];
      if (req.query.role_id) conditions.push(eq(players.roleId, req.query.role_id));
      if (req.query.expiring_soon === 'true') {
        const soonThreshold = new Date(Date.now() + EXPIRING_SOON_WINDOW_MS);
        conditions.push(isNotNull(players.roleExpiresAt));
        conditions.push(lte(players.roleExpiresAt, soonThreshold));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await app.db
        .select({
          id: players.id,
          steamId64: players.steamId64,
          canonicalName: players.canonicalName,
          eosId: players.eosId,
          lastSeenAt: players.lastSeenAt,
          roleExpiresAt: players.roleExpiresAt,
          roleComment: players.roleComment,
          roleId: roles.id,
          roleName: roles.name,
          roleColor: roles.color,
        })
        .from(players)
        // Only players with an assigned role are "VIPs"; the inner join
        // excludes everyone with role_id IS NULL by construction.
        .innerJoin(roles, eq(roles.id, players.roleId))
        .where(where)
        .orderBy(asc(players.canonicalNameNormalized));

      return rows.map((r) => ({
        id: r.id,
        steam_id64: r.steamId64 ? r.steamId64.toString() : null,
        eos_id: r.eosId,
        canonical_name: r.canonicalName,
        role: { id: r.roleId, name: r.roleName, color: r.roleColor },
        role_expires_at: r.roleExpiresAt ? r.roleExpiresAt.toISOString() : null,
        role_comment: r.roleComment,
        last_seen_at: r.lastSeenAt.toISOString(),
      }));
    },
  );
};

export default roleAssignmentsRoutes;
