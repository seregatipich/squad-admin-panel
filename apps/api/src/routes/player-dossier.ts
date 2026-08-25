import { computeKdRatio } from '@squad/db';
import {
  matches,
  matchPlayers,
  playerKitTime,
  playerStatPeriods,
  players,
  playerVehicleKills,
  playerVehicleStats,
  playerWeaponStats,
  vehicleCatalog,
} from '@squad/db/schema';
import { and, asc, desc, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const CACHE_PREFIX = 'dossier:';
const CACHE_TTL_SECONDS = 60;

const playerIdParams = z.object({ playerId: z.string().uuid() });

const dossierQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  serverId: z.union([z.literal('all'), z.string().uuid()]).default('all'),
  weaponsLimit: z.coerce.number().int().min(1).max(100).default(20),
});

/** numeric columns come back as strings from postgres; expose null (UI renders "—") or a number. */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Raw SQL aggregates bypass drizzle's column mapping: normalise Date-or-text timestamps. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function combatGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  subjectPlayerId: string,
): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  // Своё досье игрок открывает без `combat:view`: право закрывает чужие
  // боевые цифры, а не собственные, и на этом стоит блок статистики на
  // странице «Аккаунт». Сессию всё равно нужно иметь панельную — маршрут
  // не помечен `selfService`, и self-service-сессия сюда не доходит.
  if (req.user.playerId === subjectPlayerId) return null;
  if (!req.user.permissions.combatView) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

/**
 * DOSSIER-5 (#192): one consolidated read-only dossier payload per player.
 *
 * Assembles every dossier section in a single response:
 * - `skill` aggregates live over `match_players ⋈ matches` (outcome rule and
 *   `winrate = wins/(wins+losses)` → `null` as in the player-matches /
 *   combat-summary routes; `damage_dealt` is a permanent `null`).
 * - `kd_trend` reads the materialised `player_stat_periods` month rows
 *   (`matches_played > 0`; `serverId=all` → the `server_id IS NULL` rollup),
 *   and `skill.online_seconds` sums `online_seconds` over the same month rows
 *   without that filter — seeding-only months still count as time played.
 * - `weapons` (top `weaponsLimit` by kills) + `weapons_total` (full distinct
 *   weapon count) from `player_weapon_stats`.
 * - `vehicles` / `vehicle_kills` from `player_vehicle_stats` /
 *   `player_vehicle_kills`, LEFT-JOIN-enriched from `vehicle_catalog`
 *   (`unlocalized: true` + null names when the asset id is uncatalogued).
 * - `kits` from `player_kit_time`, summed across servers for `serverId=all`.
 *
 * `serverId=<uuid>` filters only `kits` and `skill`/`kd_trend` — the
 * weapon/vehicle aggregate tables carry no server dimension and stay
 * lifetime, reported as `period: "all"`. Requires the `combat:view` role flag
 * for every player except the caller's own; responses cache in Redis for 60 s
 * (`x-cache: hit|miss`).
 */
const playerDossierRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/dossier',
    {
      schema: { params: playerIdParams, querystring: dossierQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const { playerId } = req.params;
      const denied = combatGuard(req, reply, playerId);
      if (denied) return denied;

      const { from, to, serverId, weaponsLimit } = req.query;

      const known = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (known.length === 0) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const cacheKey = `${CACHE_PREFIX}${playerId}:${from?.toISOString() ?? ''}:${
        to?.toISOString() ?? ''
      }:${serverId}:${weaponsLimit}`;
      const cached = await app.redis.get(cacheKey).catch(() => null);
      if (cached) {
        reply.header('x-cache', 'hit');
        return reply.send(JSON.parse(cached));
      }

      const skillConditions: (SQL | undefined)[] = [eq(matchPlayers.playerId, playerId)];
      if (serverId !== 'all') skillConditions.push(eq(matches.serverId, serverId));
      // Границы окна уходят в запрос строками, а не объектами Date: postgres.js
      // отказывается сериализовать Date, пришедший через шаблон `sql`, и весь
      // маршрут падал с 500 на любом `?from=`/`?to=` — то есть на каждом
      // выборе периода, кроме «Всё время».
      if (from)
        skillConditions.push(sql`${matches.startedAt} >= ${from.toISOString()}::timestamptz`);
      if (to) {
        skillConditions.push(
          sql`${matches.startedAt} < ${to.toISOString()}::timestamptz + INTERVAL '1 day'`,
        );
      }

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

      const monthConditions: (SQL | undefined)[] = [
        eq(playerStatPeriods.playerId, playerId),
        eq(playerStatPeriods.periodType, 'month'),
        serverId === 'all'
          ? isNull(playerStatPeriods.serverId)
          : eq(playerStatPeriods.serverId, serverId),
      ];
      // `period_start` — это date, и сравнивать его нужно с датой, а не с
      // моментом времени: приведение к timestamptz увело бы полуночный `from`
      // в предыдущий месяц на любом отрицательном смещении сервера.
      if (from) {
        monthConditions.push(
          sql`${playerStatPeriods.periodStart} >= date_trunc('month', ${from.toISOString()}::date)::date`,
        );
      }
      if (to)
        monthConditions.push(sql`${playerStatPeriods.periodStart} <= ${to.toISOString()}::date`);

      // График строится только по месяцам с матчами — пустой месяц ломает
      // линию K/D. Времени на сервере это условие не касается: месяц, целиком
      // проведённый на сидинге, в «Онлайн» попасть обязан.
      const trendConditions: (SQL | undefined)[] = [
        ...monthConditions,
        gt(playerStatPeriods.matchesPlayed, 0),
      ];

      const trendRows = await app.db
        .select({
          month: playerStatPeriods.periodStart,
          kills: playerStatPeriods.kills,
          deaths: playerStatPeriods.deaths,
        })
        .from(playerStatPeriods)
        .where(and(...trendConditions))
        .orderBy(asc(playerStatPeriods.periodStart));

      const [onlineRow] = await app.db
        .select({ seconds: sql<string>`COALESCE(SUM(${playerStatPeriods.onlineSeconds}), 0)` })
        .from(playerStatPeriods)
        .where(and(...monthConditions));

      const weaponFilter = eq(playerWeaponStats.playerId, playerId);
      const weaponRows = await app.db
        .select({
          weapon: playerWeaponStats.weapon,
          kills: playerWeaponStats.kills,
          teamkills: playerWeaponStats.teamkills,
          damage: playerWeaponStats.damage,
          shotsEvents: playerWeaponStats.shotsEvents,
          lastUsedAt: playerWeaponStats.lastUsedAt,
        })
        .from(playerWeaponStats)
        .where(weaponFilter)
        .orderBy(desc(playerWeaponStats.kills), desc(playerWeaponStats.shotsEvents))
        .limit(weaponsLimit);

      const [weaponCount] = await app.db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(playerWeaponStats)
        .where(weaponFilter);

      const vehicleRows = await app.db
        .select({
          vehicleAssetId: playerVehicleStats.vehicleAssetId,
          kills: playerVehicleStats.kills,
          damage: playerVehicleStats.damage,
          nameEn: vehicleCatalog.nameEn,
          nameRu: vehicleCatalog.nameRu,
          vehicleClass: vehicleCatalog.vehicleClass,
        })
        .from(playerVehicleStats)
        .leftJoin(vehicleCatalog, eq(vehicleCatalog.assetId, playerVehicleStats.vehicleAssetId))
        .where(eq(playerVehicleStats.playerId, playerId))
        .orderBy(desc(playerVehicleStats.kills));

      const vehicleKillRows = await app.db
        .select({
          victimVehicleAssetId: playerVehicleKills.victimVehicleAssetId,
          weapon: playerVehicleKills.weapon,
          destroyedCount: playerVehicleKills.destroyedCount,
          nameEn: vehicleCatalog.nameEn,
          nameRu: vehicleCatalog.nameRu,
          vehicleClass: vehicleCatalog.vehicleClass,
        })
        .from(playerVehicleKills)
        .leftJoin(
          vehicleCatalog,
          eq(vehicleCatalog.assetId, playerVehicleKills.victimVehicleAssetId),
        )
        .where(eq(playerVehicleKills.playerId, playerId))
        .orderBy(desc(playerVehicleKills.destroyedCount));

      const kitConditions: (SQL | undefined)[] = [eq(playerKitTime.playerId, playerId)];
      if (serverId !== 'all') kitConditions.push(eq(playerKitTime.serverId, serverId));
      const kitSeconds = sql`SUM(${playerKitTime.seconds})`;
      const kitRows = await app.db
        .select({
          kit: playerKitTime.kit,
          seconds: sql<string>`${kitSeconds}`,
          lastPlayedAt: sql<Date | string | null>`MAX(${playerKitTime.lastPlayedAt})`,
        })
        .from(playerKitTime)
        .where(and(...kitConditions))
        .groupBy(playerKitTime.kit)
        .orderBy(desc(kitSeconds));

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
          online_seconds: Number(onlineRow?.seconds ?? 0),
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
        })),
        weapons: weaponRows.map((row) => ({
          weapon: row.weapon,
          kills: row.kills,
          teamkills: row.teamkills,
          damage: toNumber(row.damage),
          shots_events: row.shotsEvents,
          last_used_at: row.lastUsedAt?.toISOString() ?? null,
        })),
        weapons_total: weaponCount?.total ?? 0,
        vehicles: vehicleRows.map((row) => ({
          vehicle_asset_id: row.vehicleAssetId,
          name_en: row.nameEn,
          name_ru: row.nameRu,
          vehicle_class: row.vehicleClass,
          unlocalized: row.nameEn === null,
          kills: row.kills,
          damage: toNumber(row.damage),
        })),
        vehicle_kills: vehicleKillRows.map((row) => ({
          victim_vehicle_asset_id: row.victimVehicleAssetId,
          name_en: row.nameEn,
          name_ru: row.nameRu,
          vehicle_class: row.vehicleClass,
          unlocalized: row.nameEn === null,
          weapon: row.weapon,
          destroyed_count: row.destroyedCount,
        })),
        kits: kitRows.map((row) => ({
          kit: row.kit,
          seconds: Number(row.seconds),
          last_played_at: toIso(row.lastPlayedAt),
        })),
        period: 'all',
        server_id: serverId === 'all' ? null : serverId,
      };

      await app.redis
        .set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS)
        .catch(() => {});
      reply.header('x-cache', 'miss');
      return reply.send(payload);
    },
  );
};

export default playerDossierRoutes;
