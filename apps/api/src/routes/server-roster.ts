import { players } from '@squad/db/schema';
import { inArray, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildRosterResponse, collectRosterLookups, parseStoredRoster } from '../lib/roster.js';

const serverIdParams = z.object({ id: z.string().uuid() });

const serverRosterRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/roster',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: serverIdParams },
    },
    async (req) => {
      const stored = parseStoredRoster(await app.redis.get(`rcon:roster:${req.params.id}`));
      if (!stored || stored.players.length === 0) {
        return buildRosterResponse(stored, []);
      }

      const { eosIds, steamIds } = collectRosterLookups(stored.players);
      const matchClauses = [];
      if (eosIds.length > 0) matchClauses.push(inArray(players.eosId, eosIds));
      if (steamIds.length > 0) matchClauses.push(inArray(players.steamId64, steamIds));

      const identities =
        matchClauses.length > 0
          ? await app.db
              .select({
                id: players.id,
                eosId: players.eosId,
                steamId64: players.steamId64,
              })
              .from(players)
              .where(matchClauses.length === 1 ? matchClauses[0] : or(...matchClauses))
          : [];

      return buildRosterResponse(stored, identities);
    },
  );
};

export default serverRosterRoutes;
