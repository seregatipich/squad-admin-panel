import { matches, players } from '@squad/db/schema';
import { squadCrownsKey } from '@squad/shared-types';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  buildRosterResponse,
  collectRosterLookups,
  parseStoredCrowns,
  parseStoredRoster,
  parseStoredSquads,
  type RosterApiTeamFaction,
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
      // MGET cannot read a hash; both reads go out together on the one connection.
      const [[rawRoster, rawSquads], rawCrowns] = await Promise.all([
        app.redis.mget(`rcon:roster:${req.params.id}`, `rcon:squads:${req.params.id}`),
        app.redis.hgetall(squadCrownsKey(req.params.id)),
      ]);
      const stored = parseStoredRoster(rawRoster ?? null);
      const storedSquads = parseStoredSquads(rawSquads ?? null);
      const crowns = parseStoredCrowns(rawCrowns);

      const [openMatch] = await app.db
        .select({ team1: matches.team1Faction, team2: matches.team2Faction })
        .from(matches)
        .where(and(eq(matches.serverId, req.params.id), isNull(matches.endedAt)))
        .orderBy(desc(matches.startedAt))
        .limit(1);
      const teamFactions: RosterApiTeamFaction[] = [];
      if (openMatch?.team1) teamFactions.push({ team_id: 1, faction: openMatch.team1 });
      if (openMatch?.team2) teamFactions.push({ team_id: 2, faction: openMatch.team2 });

      if (!stored || stored.players.length === 0) {
        return buildRosterResponse(stored, [], storedSquads, crowns, teamFactions);
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

      return buildRosterResponse(stored, identities, storedSquads, crowns, teamFactions);
    },
  );
};

export default serverRosterRoutes;
