import { matches, matchPlayers, servers } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const RECENT_LIMIT = 10;
const WINRATE_WINDOW = 30;

const playerIdParams = z.object({ playerId: z.string().uuid() });

type MatchOutcome = 'win' | 'loss' | 'draw' | null;

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
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

function computeOutcome(team: number | null, winner: string | null): MatchOutcome {
  if (winner === null) return null;
  if (winner === 'draw') return 'draw';
  if (team === null) return null;
  return winner === `team${team}` ? 'win' : 'loss';
}

const playerMatchesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/match-summary',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const rows = await app.db
        .select({
          matchId: matches.id,
          serverId: matches.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          layer: matches.layer,
          map: matches.map,
          gameMode: matches.gameMode,
          winner: matches.winner,
          isSeed: matches.isSeed,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          durationSeconds: matches.durationSeconds,
          team: matchPlayers.team,
          playSeconds: matchPlayers.playSeconds,
        })
        .from(matchPlayers)
        .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
        .leftJoin(servers, eq(servers.id, matches.serverId))
        .where(eq(matchPlayers.playerId, req.params.playerId))
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(WINRATE_WINDOW);

      let wins = 0;
      let losses = 0;
      let draws = 0;
      for (const row of rows) {
        const outcome = computeOutcome(row.team, row.winner);
        if (outcome === 'win') wins += 1;
        else if (outcome === 'loss') losses += 1;
        else if (outcome === 'draw') draws += 1;
      }

      const recent = rows.slice(0, RECENT_LIMIT).map((row) => ({
        match_id: row.matchId,
        server_id: row.serverId,
        server_name: row.serverName,
        server_slug: row.serverSlug,
        layer: row.layer,
        map: row.map,
        game_mode: row.gameMode,
        winner: row.winner,
        is_seed: row.isSeed,
        started_at: row.startedAt.toISOString(),
        ended_at: row.endedAt ? row.endedAt.toISOString() : null,
        duration_seconds: row.durationSeconds,
        team: row.team,
        play_seconds: row.playSeconds,
        outcome: computeOutcome(row.team, row.winner),
      }));

      return {
        recent,
        winrate: {
          wins,
          losses,
          draws,
          decided: wins + losses + draws,
          considered: rows.length,
          window: WINRATE_WINDOW,
        },
      };
    },
  );
};

export default playerMatchesRoutes;
