import { playerIpHistory, playerNameHistory, players } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const playerIdParams = z.object({ steamId: z.string().regex(/^\d{17}$/) });

const playerRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players',
    {
      config: { permissions: ['player:view'], audit: false },
    },
    async () => {
      const rows = await app.db.select().from(players).orderBy(desc(players.lastSeenAt)).limit(200);
      return {
        items: rows.map((r) => ({
          steam_id64: r.steamId64.toString(),
          canonical_name: r.canonicalName,
          eos_id: r.eosId,
          first_seen_at: r.firstSeenAt,
          last_seen_at: r.lastSeenAt,
          total_time_played_seconds: Number(r.totalTimePlayedSeconds),
        })),
        total: rows.length,
      };
    },
  );

  fast.get(
    '/api/v1/players/:steamId',
    {
      config: { permissions: ['player:view'], audit: false },
      schema: { params: playerIdParams },
    },
    async (req, reply) => {
      const id = BigInt(req.params.steamId);
      const row = await app.db.query.players.findFirst({
        where: eq(players.steamId64, id),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const names = await app.db
        .select()
        .from(playerNameHistory)
        .where(eq(playerNameHistory.steamId64, id))
        .orderBy(desc(playerNameHistory.lastSeenAt));
      const ipsVisible = req.user?.permissions.permissions.has('player:view_ips') ?? false;
      const ips = ipsVisible
        ? await app.db
            .select()
            .from(playerIpHistory)
            .where(eq(playerIpHistory.steamId64, id))
            .orderBy(desc(playerIpHistory.lastSeenAt))
        : [];
      return {
        player: {
          steam_id64: row.steamId64.toString(),
          canonical_name: row.canonicalName,
          eos_id: row.eosId,
          first_seen_at: row.firstSeenAt,
          last_seen_at: row.lastSeenAt,
          total_time_played_seconds: Number(row.totalTimePlayedSeconds),
        },
        names: names.map((n) => ({
          name: n.name,
          name_normalized: n.nameNormalized,
          first_seen_at: n.firstSeenAt,
          last_seen_at: n.lastSeenAt,
          observation_count: n.observationCount,
        })),
        ips: ipsVisible
          ? ips.map((ip) => ({
              ip: String(ip.ip),
              first_seen_at: ip.firstSeenAt,
              last_seen_at: ip.lastSeenAt,
            }))
          : [],
        ips_visible: ipsVisible,
      };
    },
  );
};

export default playerRoutes;
