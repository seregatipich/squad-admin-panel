import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fetchSteamBans } from '../lib/steam-bans.js';
import { fetchSteamOwnedGames } from '../lib/steam-owned-games.js';
import { fetchSteamProfile } from '../lib/steam-profile.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });

/**
 * INT-1 (#76): on-demand Steam Web API enrichment for a single player.
 *
 * Gated by the catalog permission `player:view` — whoever may open the player
 * card may also refresh it, because the call changes no game state, only the
 * panel's copy of public Steam data.
 *
 * The three Steam reads go through the `@squad/steam-api` Redis caches shared
 * with the background refresh worker: profile 1 h, bans 6 h, owned games 24 h.
 * That is deliberate: repeated clicks persist the cached snapshot instead of
 * burning the operator's daily Steam quota. The write is all-or-nothing — if
 * any of the three reads fails the route answers 502 and leaves the stored
 * snapshot untouched, so a partial outage never produces a half-updated row.
 */
const playerSteamRefreshRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/players/:playerId/steam-refresh',
    {
      schema: { params: playerIdParams },
      config: {
        permissions: ['player:view'],
        audit: { action: 'player.steam_refresh', resource: 'player' },
      },
    },
    async (req, reply) => {
      const playerId = req.params.playerId;
      const [player] = await app.db
        .select({ id: players.id, steamId64: players.steamId64 })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (player.steamId64 == null) {
        reply.code(409);
        return { error: 'no_steam_id' };
      }
      const apiKey = app.config.STEAM_API_KEY ?? '';
      if (!apiKey) {
        reply.code(503);
        return { error: 'steam_api_key_missing' };
      }

      const steamId64 = player.steamId64;
      const deps = { apiKey, redis: app.redis };
      const [profile, bans, ownedGames] = await Promise.all([
        fetchSteamProfile(steamId64, deps),
        fetchSteamBans([steamId64], deps),
        fetchSteamOwnedGames(steamId64, deps),
      ]);
      if (!profile || !bans || !ownedGames) {
        req.log.warn(
          {
            steamId64: String(steamId64),
            profile: profile !== null,
            bans: bans !== null,
            ownedGames: ownedGames !== null,
          },
          'steam refresh aborted: Steam Web API did not answer',
        );
        reply.code(502);
        return { error: 'steam_api_error' };
      }

      const ban = bans.get(String(steamId64));
      const vacBanCount = ban?.vacBanCount ?? 0;
      const gameBanCount = ban?.gameBanCount ?? 0;
      // Steam reports DaysSinceLastBan = 0 for a spotless account, which is
      // indistinguishable from "banned today"; only keep it when a ban exists.
      const daysSinceLastBan =
        vacBanCount > 0 || gameBanCount > 0 ? (ban?.daysSinceLastBan ?? null) : null;
      const snapshot = {
        avatarUrl: profile.avatarUrl || null,
        personaName: profile.persona || null,
        profileVisibility: profile.visibility,
        steamAccountCreatedAt:
          profile.createdAt === null ? null : new Date(profile.createdAt * 1000),
        vacBanned: ban?.vacBanned ?? false,
        vacBanCount,
        gameBanCount,
        daysSinceLastBan,
        ownsSquad: ownedGames.ownsSquad,
        steamPlaytimeMinutes: ownedGames.playtimeMinutes,
        steamCheckedAt: new Date(),
      };

      await app.db.update(players).set(snapshot).where(eq(players.id, playerId));

      return {
        avatar_url: snapshot.avatarUrl,
        persona_name: snapshot.personaName,
        profile_visibility: snapshot.profileVisibility,
        steam_account_created_at: snapshot.steamAccountCreatedAt?.toISOString() ?? null,
        vac_banned: snapshot.vacBanned,
        vac_ban_count: snapshot.vacBanCount,
        game_ban_count: snapshot.gameBanCount,
        days_since_last_ban: snapshot.daysSinceLastBan,
        owns_squad: snapshot.ownsSquad,
        steam_playtime_minutes: snapshot.steamPlaytimeMinutes,
        steam_checked_at: snapshot.steamCheckedAt.toISOString(),
      };
    },
  );
};

export default playerSteamRefreshRoutes;
