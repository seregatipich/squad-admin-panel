import { type LayerRow as LayerDbRow, layers } from '@squad/db/schema';
import type { LayerRow, LayerTeams } from '@squad/shared-types';
import { layerListQuery } from '@squad/shared-types';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function readGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function serialize(row: LayerDbRow): LayerRow {
  return {
    id: row.id,
    name: row.name,
    map: row.map,
    gamemode: row.gamemode,
    version: row.version,
    is_seed: row.isSeed,
    teams: (row.teams ?? {}) as LayerTeams,
    depot_version: row.depotVersion,
    deprecated: row.deprecated,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * ROT-1 (#144): layer catalog powering the rotation editor (ROT-2), the
 * current/next-map widget (ROT-3), and the rotation calendar (ROT-4).
 *
 * Read-only for now: rows come from the static fallback dataset applied by
 * migration 0042. The depot-sync upsert/deprecate path is a follow-up.
 */
const layersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/layers',
    { schema: { querystring: layerListQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = readGuard(req, reply);
      if (denied) return denied;

      const { map, gamemode, is_seed } = req.query;
      const clauses: SQL[] = [];
      if (map) clauses.push(eq(layers.map, map));
      if (gamemode) clauses.push(eq(layers.gamemode, gamemode));
      if (is_seed !== undefined) clauses.push(eq(layers.isSeed, is_seed === 'true'));

      const rows = await app.db
        .select()
        .from(layers)
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(asc(layers.name));

      return { rows: rows.map(serialize) };
    },
  );
};

export default layersRoutes;
