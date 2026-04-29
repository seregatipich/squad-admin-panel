import { servers } from '@squad/db/schema';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForServer } from '../lib/admins-cfg-sync.js';

const STATUS_KEY_PREFIX = 'admins-cfg:status:';

interface AdminsCfgStatus {
  state: 'unknown' | 'in_sync' | 'drift' | 'unreachable' | 'syncing';
  last_synced_at: string | null;
  last_segment_hash: string | null;
  last_db_hash: string | null;
  groups_count?: number;
  admins_count?: number;
  error?: string | null;
  attempts?: number;
  unreachable_since?: string | null;
}

const idQuery = z.object({ server_id: z.string().uuid() });

const adminsCfgRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/admins-cfg/drift',
    {
      schema: { querystring: idQuery },
      config: { permissions: ['admin_group:view'], audit: false },
    },
    async (req, reply) => {
      const row = await app.db
        .select({ id: servers.id, deletedAt: servers.deletedAt })
        .from(servers)
        .where(eq(servers.id, req.query.server_id))
        .limit(1);
      if (row.length === 0 || row[0]?.deletedAt) {
        reply.code(404);
        return { error: 'server_not_found' };
      }
      const raw = await app.redis.get(`${STATUS_KEY_PREFIX}${req.query.server_id}`);
      if (!raw) {
        return {
          server_id: req.query.server_id,
          status: {
            state: 'unknown' as const,
            last_synced_at: null,
            last_segment_hash: null,
            last_db_hash: null,
          } satisfies AdminsCfgStatus,
        };
      }
      const status = JSON.parse(raw) as AdminsCfgStatus;
      return { server_id: req.query.server_id, status };
    },
  );

  fast.get(
    '/api/v1/admins-cfg/drift/all',
    { config: { permissions: ['admin_group:view'], audit: false } },
    async () => {
      const rows = await app.db
        .select({ id: servers.id, displayName: servers.displayName })
        .from(servers)
        .where(isNull(servers.deletedAt));
      const results: Array<{ server_id: string; display_name: string; status: AdminsCfgStatus }> =
        [];
      for (const row of rows) {
        const raw = await app.redis.get(`${STATUS_KEY_PREFIX}${row.id}`);
        const status: AdminsCfgStatus = raw
          ? (JSON.parse(raw) as AdminsCfgStatus)
          : {
              state: 'unknown',
              last_synced_at: null,
              last_segment_hash: null,
              last_db_hash: null,
            };
        results.push({ server_id: row.id, display_name: row.displayName, status });
      }
      return { items: results };
    },
  );

  fast.post(
    '/api/v1/admins-cfg/sync',
    {
      schema: { querystring: idQuery },
      config: {
        permissions: ['admin_group:edit'],
        audit: { action: 'admins_cfg.force_sync', resource: 'server' },
      },
    },
    async (req, reply) => {
      const row = await app.db
        .select({ id: servers.id, deletedAt: servers.deletedAt })
        .from(servers)
        .where(eq(servers.id, req.query.server_id))
        .limit(1);
      if (row.length === 0 || row[0]?.deletedAt) {
        reply.code(404);
        return { error: 'server_not_found' };
      }
      await publishAdminsCfgSyncForServer(app.redis, req.query.server_id, {
        reason: 'force_sync',
        actor_steam_id64: req.user?.steamId64 ? String(req.user.steamId64) : null,
        enqueued_at: new Date().toISOString(),
        request_id: req.id,
      });
      return { ok: true };
    },
  );
};

export default adminsCfgRoutes;
