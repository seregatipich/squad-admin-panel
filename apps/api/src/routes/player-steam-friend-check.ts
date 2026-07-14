import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fetchSteamFriendCheck } from '../lib/steam-friends.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const query = z.object({ other: z.string().uuid() });

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

/** ALT-5 Steam-friend edge check, gated by panel_access. */
const playerSteamFriendCheckRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/steam-friend-check',
    {
      schema: { params: playerIdParams, querystring: query },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      if (req.params.playerId === req.query.other) {
        reply.code(422);
        return { error: 'same_player' };
      }

      const rows = await app.db
        .select({ id: players.id, steamId64: players.steamId64 })
        .from(players)
        .where(eq(players.id, req.params.playerId));
      const otherRows = await app.db
        .select({ id: players.id, steamId64: players.steamId64 })
        .from(players)
        .where(eq(players.id, req.query.other));
      const player = rows[0];
      const other = otherRows[0];
      if (!player || !other) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (player.steamId64 == null || other.steamId64 == null) {
        return { in_friend: null, reason: 'no_steam_id', cached: false };
      }
      const result = await fetchSteamFriendCheck(player.steamId64, other.steamId64, {
        apiKey: app.config.STEAM_API_KEY ?? '',
        redis: app.redis,
      });
      return {
        in_friend: result.inFriend,
        reason: result.reason,
        cached: result.cached,
      };
    },
  );
};

export default playerSteamFriendCheckRoutes;
