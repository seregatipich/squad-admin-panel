import {
  clanMembers,
  clans,
  matches,
  matchPlayers,
  playerDailyPresence,
  playerStatPeriods,
  players,
} from '@squad/db/schema';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const PUBLIC_RATE_LIMIT = 60;
const PUBLIC_STATS_DAYS = 30;
const PUBLIC_MATCHES_LIMIT = 20;

const clanIdParams = z.object({ id: z.string().uuid() });

interface PublicActivityPoint {
  day: string;
  online_seconds: number;
}

function dayBefore(day: string, days: number): string {
  const value = Date.parse(`${day}T00:00:00.000Z`) - days * 86_400_000;
  return new Date(value).toISOString().slice(0, 10);
}

function publicWindow(): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10);
  return { from: dayBefore(to, PUBLIC_STATS_DAYS - 1), to };
}

function emptyActivity(from: string, to: string): PublicActivityPoint[] {
  const points: PublicActivityPoint[] = [];
  for (let day = from; day <= to; day = dayBefore(day, -1)) {
    points.push({ day, online_seconds: 0 });
  }
  return points;
}

/**
 * Public, unauthenticated clan pages (CLAN-10): every query is deliberately
 * projected into a PII-free response. In particular, this route never selects
 * player identifiers, platform identifiers, priority state, last-seen state,
 * or server identifiers.
 */
const publicClansRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/public/clans',
    {
      config: {
        audit: false,
        public: true,
        rateLimit: { max: PUBLIC_RATE_LIMIT, timeWindow: '1 minute' },
      },
    },
    async () => {
      const rows = await app.db
        .select({
          id: clans.id,
          name: clans.name,
          tags: clans.tags,
          description: clans.description,
        })
        .from(clans)
        .where(and(eq(clans.isPublic, true), isNull(clans.deletedAt)))
        .orderBy(asc(clans.name));

      return {
        items: rows,
        total: rows.length,
      };
    },
  );

  fast.get(
    '/api/v1/public/clans/:id',
    {
      config: {
        audit: false,
        public: true,
        rateLimit: { max: PUBLIC_RATE_LIMIT, timeWindow: '1 minute' },
      },
      schema: { params: clanIdParams },
    },
    async (req, reply) => {
      const [clan] = await app.db
        .select({
          id: clans.id,
          name: clans.name,
          tags: clans.tags,
          description: clans.description,
        })
        .from(clans)
        .where(and(eq(clans.id, req.params.id), eq(clans.isPublic, true), isNull(clans.deletedAt)))
        .limit(1);

      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }

      const members = await app.db
        .select({ nickname: players.canonicalName, role: clanMembers.memberRole })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt), asc(players.canonicalName));
      const memberIds = await app.db
        .select({ playerId: clanMembers.playerId })
        .from(clanMembers)
        .where(eq(clanMembers.clanId, clan.id));
      const playerIds = memberIds.map((row) => row.playerId);
      const { from, to } = publicWindow();

      const activity = emptyActivity(from, to);
      if (playerIds.length > 0) {
        const activityRows = await app.db
          .select({
            day: playerDailyPresence.day,
            onlineSeconds: sql<number>`COALESCE(SUM(${playerDailyPresence.onlineSeconds}), 0)::int`,
          })
          .from(playerDailyPresence)
          .where(
            and(
              inArray(playerDailyPresence.playerId, playerIds),
              gte(playerDailyPresence.day, from),
              lte(playerDailyPresence.day, to),
            ),
          )
          .groupBy(playerDailyPresence.day)
          .orderBy(asc(playerDailyPresence.day));
        const activityByDay = new Map(
          activityRows.map((row) => [row.day, Number(row.onlineSeconds)]),
        );
        for (const point of activity) point.online_seconds = activityByDay.get(point.day) ?? 0;
      }

      const statRows =
        playerIds.length === 0
          ? []
          : await app.db
              .select({
                onlineSeconds: sql<number>`COALESCE(SUM(${playerStatPeriods.onlineSeconds}), 0)::int`,
                kills: sql<number>`COALESCE(SUM(${playerStatPeriods.kills}), 0)::int`,
                deaths: sql<number>`COALESCE(SUM(${playerStatPeriods.deaths}), 0)::int`,
                revives: sql<number>`COALESCE(SUM(${playerStatPeriods.revives}), 0)::int`,
                matchesPlayed: sql<number>`COALESCE(SUM(${playerStatPeriods.matchesPlayed}), 0)::int`,
              })
              .from(playerStatPeriods)
              .where(
                and(
                  inArray(playerStatPeriods.playerId, playerIds),
                  eq(playerStatPeriods.periodType, 'day'),
                  isNull(playerStatPeriods.serverId),
                  gte(playerStatPeriods.periodStart, from),
                  lte(playerStatPeriods.periodStart, to),
                ),
              );
      const stat = statRows[0];
      const kills = Number(stat?.kills ?? 0);
      const deaths = Number(stat?.deaths ?? 0);
      const matchesWhere = sql`EXISTS (
        SELECT 1
        FROM ${matchPlayers} public_mp
        INNER JOIN ${clanMembers} public_cm ON public_cm.player_id = public_mp.player_id
        WHERE public_mp.match_id = ${matches.id}
          AND public_cm.clan_id = ${clan.id}
      )`;
      const [matchCount] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(matches)
        .where(matchesWhere);
      const history = await app.db
        .select({
          id: matches.id,
          map: matches.map,
          layer: matches.layer,
          winner: matches.winner,
          isSeed: matches.isSeed,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          durationSeconds: matches.durationSeconds,
        })
        .from(matches)
        .where(matchesWhere)
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(PUBLIC_MATCHES_LIMIT);

      return {
        ...clan,
        roster: members,
        activity,
        stats: {
          from,
          to,
          roster_size: playerIds.length,
          online_seconds: Number(stat?.onlineSeconds ?? 0),
          matches_played: Number(stat?.matchesPlayed ?? 0),
          matches_total: Number(matchCount?.count ?? 0),
          kills,
          deaths,
          revives: Number(stat?.revives ?? 0),
          kd: deaths === 0 ? kills : Math.round((kills / deaths) * 100) / 100,
        },
        matches: history.map((row) => ({
          id: row.id,
          map: row.map,
          layer: row.layer,
          winner: row.winner,
          is_seed: row.isSeed,
          started_at: row.startedAt.toISOString(),
          ended_at: row.endedAt?.toISOString() ?? null,
          duration_seconds: row.durationSeconds,
        })),
      };
    },
  );
};

export default publicClansRoutes;
