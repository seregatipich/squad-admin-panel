import { serverSettings, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const serverIdParams = z.object({ id: z.string().uuid() });

const seedingSettingsBody = z
  .object({
    seed_live_at: z.number().int().min(1).max(200).optional(),
    seed_hysteresis: z.number().int().min(0).max(50).optional(),
  })
  .refine((body) => body.seed_live_at !== undefined || body.seed_hysteresis !== undefined, {
    message: 'at least one of seed_live_at, seed_hysteresis is required',
  });

interface SeedingRedisState {
  state?: 'seeding' | 'live';
  current_players?: number;
  live_at?: number;
  progress_pct?: number;
  started_at?: string | null;
  layer?: string | null;
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
 * Seeding-state routes (SEED-1, #140): serves the per-server seeding state
 * maintained by worker-rcon's state machine (`apps/workers/rcon/src/seeding.ts`)
 * and lets an admin with the `manageserver` squad permission tune its
 * thresholds. Read is gated on `panel_access`; the threshold write is gated
 * on the `manageserver` squad permission (Owner already has every squad
 * permission via `loadUserPermissions`).
 */
const serverSeedingRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/seeding',
    { schema: { params: serverIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { id } = req.params;
      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const raw = await app.redis.get(`seeding:state:${id}`);
      if (!raw) {
        return {
          state: 'unknown' as const,
          current_players: null,
          live_at: null,
          progress_pct: null,
          started_at: null,
        };
      }

      let parsed: SeedingRedisState;
      try {
        parsed = JSON.parse(raw) as SeedingRedisState;
      } catch {
        return {
          state: 'unknown' as const,
          current_players: null,
          live_at: null,
          progress_pct: null,
          started_at: null,
        };
      }

      return {
        state: parsed.state ?? 'unknown',
        current_players: parsed.current_players ?? null,
        live_at: parsed.live_at ?? null,
        progress_pct: parsed.progress_pct ?? null,
        started_at: parsed.started_at ?? null,
      };
    },
  );

  fast.put(
    '/api/v1/servers/:id/seeding-settings',
    { schema: { params: serverIdParams, body: seedingSettingsBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.squadPermissions.has('manageserver')) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'manageserver' };
      }

      const { id } = req.params;
      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const currentSettings = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, id),
      });
      if (!currentSettings) {
        reply.code(404);
        return { error: 'settings_not_found' };
      }

      const before = {
        seed_live_at: currentSettings.seedLiveAt,
        seed_hysteresis: currentSettings.seedHysteresis,
      };

      const updateSet: Partial<typeof serverSettings.$inferInsert> = {};
      if (req.body.seed_live_at !== undefined) updateSet.seedLiveAt = req.body.seed_live_at;
      if (req.body.seed_hysteresis !== undefined) {
        updateSet.seedHysteresis = req.body.seed_hysteresis;
      }

      await app.db.update(serverSettings).set(updateSet).where(eq(serverSettings.serverId, id));

      const after = {
        seed_live_at: updateSet.seedLiveAt ?? before.seed_live_at,
        seed_hysteresis: updateSet.seedHysteresis ?? before.seed_hysteresis,
      };

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'server.seeding_settings_update',
        targetType: 'server',
        targetId: id,
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });

      return { server_id: id, ...after };
    },
  );
};

export default serverSeedingRoutes;
