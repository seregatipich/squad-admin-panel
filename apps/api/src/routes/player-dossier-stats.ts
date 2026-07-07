import { playerVehicleKills, playerVehicleStats, playerWeaponStats } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const playerIdParams = z.object({ playerId: z.string().uuid() });

/** numeric columns come back as strings from postgres; expose null (UI renders "—") or a number. */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

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
 * DOSSIER-2 (#189): read-only per-weapon and per-vehicle dossier aggregates for a
 * single player. Backed by the `player_weapon_stats`, `player_vehicle_stats` and
 * `player_vehicle_kills` tables maintained by the log-ingest incremental path and
 * the reconcile job. Requires panel access.
 */
const playerDossierStatsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/weapon-stats',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const rows = await app.db
        .select({
          weapon: playerWeaponStats.weapon,
          kills: playerWeaponStats.kills,
          teamkills: playerWeaponStats.teamkills,
          damage: playerWeaponStats.damage,
          shotsEvents: playerWeaponStats.shotsEvents,
          lastUsedAt: playerWeaponStats.lastUsedAt,
        })
        .from(playerWeaponStats)
        .where(eq(playerWeaponStats.playerId, req.params.playerId))
        .orderBy(desc(playerWeaponStats.kills), desc(playerWeaponStats.shotsEvents));

      return {
        weapons: rows.map((row) => ({
          weapon: row.weapon,
          kills: row.kills,
          teamkills: row.teamkills,
          damage: toNumber(row.damage),
          shots_events: row.shotsEvents,
          last_used_at: row.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/vehicle-stats',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const fromVehicle = await app.db
        .select({
          vehicleAssetId: playerVehicleStats.vehicleAssetId,
          kills: playerVehicleStats.kills,
          damage: playerVehicleStats.damage,
        })
        .from(playerVehicleStats)
        .where(eq(playerVehicleStats.playerId, req.params.playerId))
        .orderBy(desc(playerVehicleStats.kills));

      const destroyed = await app.db
        .select({
          victimVehicleAssetId: playerVehicleKills.victimVehicleAssetId,
          weapon: playerVehicleKills.weapon,
          destroyedCount: playerVehicleKills.destroyedCount,
        })
        .from(playerVehicleKills)
        .where(eq(playerVehicleKills.playerId, req.params.playerId))
        .orderBy(desc(playerVehicleKills.destroyedCount));

      return {
        from_vehicle: fromVehicle.map((row) => ({
          vehicle_asset_id: row.vehicleAssetId,
          kills: row.kills,
          damage: toNumber(row.damage),
        })),
        destroyed: destroyed.map((row) => ({
          victim_vehicle_asset_id: row.victimVehicleAssetId,
          weapon: row.weapon,
          destroyed_count: row.destroyedCount,
        })),
      };
    },
  );
};

export default playerDossierStatsRoutes;
