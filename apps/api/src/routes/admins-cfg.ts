import { servers } from '@squad/db/schema';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForServer } from '../lib/admins-cfg-sync.js';

const STATUS_KEY_PREFIX = 'admins-cfg:status:';

/**
 * Sync status the config-sync worker publishes per server. Parsed rather than
 * cast: a truncated value or one written by a different worker version reads
 * as `unknown` instead of failing the request (#82).
 */
const adminsCfgStatus = z.object({
  state: z.enum(['unknown', 'in_sync', 'drift', 'unreachable', 'syncing']),
  last_synced_at: z.string().nullable(),
  last_segment_hash: z.string().nullable(),
  last_db_hash: z.string().nullable(),
  groups_count: z.number().optional(),
  admins_count: z.number().optional(),
  error: z.string().nullable().optional(),
  attempts: z.number().optional(),
  unreachable_since: z.string().nullable().optional(),
});
type AdminsCfgStatus = z.infer<typeof adminsCfgStatus>;

const UNKNOWN_STATUS: AdminsCfgStatus = {
  state: 'unknown',
  last_synced_at: null,
  last_segment_hash: null,
  last_db_hash: null,
};

const idQuery = z.object({ server_id: z.string().uuid() });

const adminsCfgRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /** Parses one cached status; a missing or malformed value reads as `unknown`. */
  const parseStatus = (serverId: string, raw: string | null): AdminsCfgStatus => {
    if (!raw) return UNKNOWN_STATUS;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = adminsCfgStatus.safeParse(value);
    if (parsed.success) return parsed.data;
    app.log.warn({ serverId }, 'admins-cfg: malformed sync status in redis; reporting unknown');
    return UNKNOWN_STATUS;
  };

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
      return { server_id: req.query.server_id, status: parseStatus(req.query.server_id, raw) };
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
      if (rows.length === 0) return { items: [] };
      // One MGET instead of a GET per server (#83).
      const raws = await app.redis.mget(rows.map((row) => `${STATUS_KEY_PREFIX}${row.id}`));
      const items = rows.map((row, index) => ({
        server_id: row.id,
        display_name: row.displayName,
        status: parseStatus(row.id, raws[index] ?? null),
      }));
      return { items };
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
      await publishAdminsCfgSyncForServer(app.db, req.query.server_id, {
        reason: 'force_sync',
        actor_player_id: req.user?.playerId ?? null,
        enqueued_at: new Date().toISOString(),
        request_id: req.requestId,
      });
      return { ok: true };
    },
  );
};

export default adminsCfgRoutes;
