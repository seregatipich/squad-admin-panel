import { players } from '@squad/db/schema';
import { inArray, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  buildRosterResponse,
  collectRosterLookups,
  parseStoredRoster,
  parseStoredSquads,
} from '../lib/roster.js';

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
      const [rawRoster, rawSquads] = await app.redis.mget(
        `rcon:roster:${req.params.id}`,
        `rcon:squads:${req.params.id}`,
      );
      const stored = parseStoredRoster(rawRoster ?? null);
      const storedSquads = parseStoredSquads(rawSquads ?? null);
      if (!stored || stored.players.length === 0) {
        return buildRosterResponse(stored, [], storedSquads);
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

      return buildRosterResponse(stored, identities, storedSquads);
    },
  );
};

export default serverRosterRoutes;
