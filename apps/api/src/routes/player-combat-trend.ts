import { computeKdRatio } from '@squad/db';
import { matches, matchPlayers, playerStatPeriods, players } from '@squad/db/schema';
import { and, asc, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const CACHE_PREFIX = 'player-combat:';
const CACHE_TTL_SECONDS = 60;

const playerIdParams = z.object({ playerId: z.string().uuid() });

const combatSummaryQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  serverId: z.union([z.literal('all'), z.string().uuid()]).default('all'),
});

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

/**
 * DOSSIER-4 (#191): combat summary + monthly K/D trend for a single player.
 *
 * `skill` totals (kills/deaths/kd/teamkills/revives, matches, win/loss/draw
 * outcomes) aggregate live over `match_players ⋈ matches`, so `from`/`to`
 * filter at day granularity via `matches.started_at`. Outcomes follow the
 * player-matches rule: `matches.winner = 'team' || match_players.team` is a
 * win, a different decided winner is a loss, `'draw'` counts regardless of
 * team, and an undecided match (`winner IS NULL` or unknown team) is none of
 * the three. `winrate = wins / (wins + losses)` — draws are excluded from the
 * denominator; `null` (never 0) when no decided matches exist.
 * `damage_dealt` is a permanent `null`: `match_players` carries no damage.
 *
 * `kd_trend` reads the materialised `player_stat_periods` month rows
 * (`serverId=all` → the all-servers rollup, `server_id IS NULL`); months
 * without matches have no row (or `matches_played = 0`) and are absent from
 * the response — the UI draws the zeros itself. Requires panel access;
 * responses are cached in Redis for 60 s (`x-cache: hit|miss`).
 */
const playerCombatTrendRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/combat-summary',
    {
      schema: { params: playerIdParams, querystring: combatSummaryQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { from, to, serverId } = req.query;

      const known = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (known.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const cacheKey = `${CACHE_PREFIX}${playerId}:${from ?? ''}:${to ?? ''}:${serverId}`;
      const cached = await app.redis.get(cacheKey).catch(() => null);
      if (cached) {
        reply.header('x-cache', 'hit');
        return reply.send(JSON.parse(cached));
      }

      const skillConditions: (SQL | undefined)[] = [eq(matchPlayers.playerId, playerId)];
      if (serverId !== 'all') skillConditions.push(eq(matches.serverId, serverId));
      if (from) skillConditions.push(sql`${matches.startedAt} >= ${from}::date`);
      if (to) skillConditions.push(sql`${matches.startedAt} < (${to}::date + INTERVAL '1 day')`);

      const winExpr = sql`${matches.winner} = 'team' || ${matchPlayers.team}`;
      const [skillRow] = await app.db
        .select({
          kills: sql<number>`COALESCE(SUM(${matchPlayers.kills}), 0)::int`,
          deaths: sql<number>`COALESCE(SUM(${matchPlayers.deaths}), 0)::int`,
          teamkills: sql<number>`COALESCE(SUM(${matchPlayers.teamkills}), 0)::int`,
          revives: sql<number>`COALESCE(SUM(${matchPlayers.revives}), 0)::int`,
          matches: sql<number>`COUNT(DISTINCT ${matches.id})::int`,
          wins: sql<number>`COUNT(*) FILTER (WHERE ${winExpr})::int`,
          losses: sql<number>`COUNT(*) FILTER (WHERE ${matches.winner} IN ('team1', 'team2')
            AND ${matchPlayers.team} IS NOT NULL AND NOT (${winExpr}))::int`,
          draws: sql<number>`COUNT(*) FILTER (WHERE ${matches.winner} = 'draw')::int`,
        })
        .from(matchPlayers)
        .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
        .where(and(...skillConditions));

      const trendConditions: (SQL | undefined)[] = [
        eq(playerStatPeriods.playerId, playerId),
        eq(playerStatPeriods.periodType, 'month'),
        serverId === 'all'
          ? isNull(playerStatPeriods.serverId)
          : eq(playerStatPeriods.serverId, serverId),
        gt(playerStatPeriods.matchesPlayed, 0),
      ];
      if (from) {
        trendConditions.push(
          sql`${playerStatPeriods.periodStart} >= date_trunc('month', ${from}::date)::date`,
        );
      }
      if (to) trendConditions.push(sql`${playerStatPeriods.periodStart} <= ${to}::date`);

      const trendRows = await app.db
        .select({
          month: playerStatPeriods.periodStart,
          kills: playerStatPeriods.kills,
          deaths: playerStatPeriods.deaths,
          kdRatio: playerStatPeriods.kdRatio,
          matches: playerStatPeriods.matchesPlayed,
        })
        .from(playerStatPeriods)
        .where(and(...trendConditions))
        .orderBy(asc(playerStatPeriods.periodStart));

      // A grand-total aggregate always yields one row; the fallback only
      // satisfies the type system.
      const { kills, deaths, teamkills, revives, wins, losses, draws } = skillRow ?? {
        kills: 0,
        deaths: 0,
        teamkills: 0,
        revives: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      };
      const decided = wins + losses;
      const payload = {
        skill: {
          kills,
          deaths,
          kd: computeKdRatio(kills, deaths),
          teamkills,
          revives,
          damage_dealt: null,
          matches: skillRow?.matches ?? 0,
          wins,
          losses,
          draws,
          winrate: decided === 0 ? null : wins / decided,
        },
        kd_trend: trendRows.map((row) => ({
          month: row.month,
          kills: row.kills,
          deaths: row.deaths,
          kd: Number(row.kdRatio),
          matches: row.matches,
        })),
        period: {
          from: from ?? null,
          to: to ?? null,
          server_id: serverId === 'all' ? null : serverId,
        },
      };

      await app.redis
        .set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS)
        .catch(() => {});
      reply.header('x-cache', 'miss');
      return reply.send(payload);
    },
  );
};

export default playerCombatTrendRoutes;
