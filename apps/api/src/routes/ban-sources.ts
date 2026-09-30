import { externalBanSources, externalBans } from '@squad/db/schema';
import { checkOutboundUrl } from '@squad/shared-config';
import { EXTERNAL_BAN_CACHE_VERSION_KEY } from '@squad/shared-types';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { encrypt, serialize } from '../lib/crypto.js';

const BAN_SOURCE_FORMATS = ['squad_bans_cfg', 'battlemetrics_json', 'json_generic', 'csv'] as const;
const TRUST_LEVELS = ['trusted', 'normal', 'low'] as const;
const ON_MATCH_ACTIONS = ['none', 'alert', 'kick'] as const;

/**
 * A ban-source URL is fetched unattended by `worker-ban-sync`, so it must not
 * reach the panel's own network (audit #100): `checkOutboundUrl` refuses
 * non-http(s) schemes, embedded credentials, Compose service names and
 * non-public IP literals. The worker re-checks every resolved address.
 */
const sourceUrl = z
  .string()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    const check = checkOutboundUrl(value);
    if (!check.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `url_not_allowed: ${check.reason}` });
    }
  });

const createBody = z.object({
  name: z.string().trim().min(1).max(128),
  url: sourceUrl,
  format: z.enum(BAN_SOURCE_FORMATS),
  trust_level: z.enum(TRUST_LEVELS).default('normal'),
  on_match: z.enum(ON_MATCH_ACTIONS).default('alert'),
  discord_url: z.string().url().max(2048).nullable().optional(),
  auth_header: z.string().min(1).max(1024).nullable().optional(),
  enabled: z.boolean().default(true),
  poll_interval_minutes: z.number().int().min(15).max(10080).default(60),
  parser_config: z.record(z.unknown()).optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  url: sourceUrl.optional(),
  format: z.enum(BAN_SOURCE_FORMATS).optional(),
  trust_level: z.enum(TRUST_LEVELS).optional(),
  on_match: z.enum(ON_MATCH_ACTIONS).optional(),
  discord_url: z.string().url().max(2048).nullable().optional(),
  auth_header: z.string().min(1).max(1024).nullable().optional(),
  enabled: z.boolean().optional(),
  poll_interval_minutes: z.number().int().min(15).max(10080).optional(),
  parser_config: z.record(z.unknown()).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

interface SourceRow {
  id: string;
  name: string;
  url: string;
  format: string;
  authHeaderEncrypted: Buffer | null;
  trustLevel: string;
  onMatch: string;
  discordUrl: string | null;
  enabled: boolean;
  pollIntervalMinutes: number;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  importedCount: number;
  parserConfig: unknown;
  consecutiveFailures: number;
  createdAt: Date;
}

interface PublicSource {
  id: string;
  name: string;
  url: string;
  format: string;
  trust_level: string;
  on_match: string;
  discord_url: string | null;
  enabled: boolean;
  poll_interval_minutes: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  imported_count: number;
  record_count: number;
  has_auth_header: boolean;
  parser_config: unknown;
  consecutive_failures: number;
  created_at: string;
}

function toPublic(row: SourceRow, recordCount: number): PublicSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    format: row.format,
    trust_level: row.trustLevel,
    on_match: row.onMatch,
    discord_url: row.discordUrl,
    enabled: row.enabled,
    poll_interval_minutes: row.pollIntervalMinutes,
    last_sync_at: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    last_sync_status: row.lastSyncStatus,
    last_sync_error: row.lastSyncError,
    imported_count: row.importedCount,
    record_count: recordCount,
    has_auth_header: row.authHeaderEncrypted != null,
    parser_config: row.parserConfig,
    consecutive_failures: row.consecutiveFailures,
    created_at: row.createdAt.toISOString(),
  };
}

function auditSnapshot(source: PublicSource) {
  return {
    name: source.name,
    url: source.url,
    format: source.format,
    trust_level: source.trust_level,
    on_match: source.on_match,
    discord_url: source.discord_url,
    enabled: source.enabled,
    poll_interval_minutes: source.poll_interval_minutes,
    has_auth_header: source.has_auth_header,
  };
}

/**
 * `panel_access` gate for the read routes, which also declare
 * `config.permissions: ['ban_source:view']` so an API token reaches them only when
 * delegated that scope (audit #101). This guard keeps a session whose role
 * lacks `panel_access` out even if it holds an explicit `ban_source:view` row. The
 * auth hook has already answered 401 to an anonymous caller.
 */
function denyRead(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.permissions.panelAccess) return false;
  reply.code(403).send({ error: 'forbidden' });
  return true;
}

function denyManage(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.permissions.canManageBanSources) return false;
  reply.code(403).send({ error: 'forbidden', required: 'can_manage_ban_sources' });
  return true;
}

const banSourcesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function recordCounts(): Promise<Map<string, number>> {
    const rows = await app.db
      .select({ sourceId: externalBans.sourceId, count: sql<number>`count(*)::int` })
      .from(externalBans)
      .groupBy(externalBans.sourceId);
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.sourceId, Number(row.count));
    return map;
  }

  async function recordCountFor(sourceId: string): Promise<number> {
    const rows = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId));
    return Number(rows[0]?.count ?? 0);
  }

  fast.get(
    '/api/v1/ban-sources',
    { config: { audit: false, permissions: ['ban_source:view'] } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      const sources = (await app.db
        .select()
        .from(externalBanSources)
        .orderBy(externalBanSources.createdAt)) as unknown as SourceRow[];
      const counts = await recordCounts();
      return sources.map((source) => toPublic(source, counts.get(source.id) ?? 0));
    },
  );

  fast.get(
    '/api/v1/ban-sources/:id',
    { schema: { params: idParam }, config: { audit: false, permissions: ['ban_source:view'] } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      const rows = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1)) as unknown as SourceRow[];
      const source = rows[0];
      if (!source) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      return toPublic(source, await recordCountFor(source.id));
    },
  );

  fast.post(
    '/api/v1/ban-sources',
    {
      schema: { body: createBody },
      config: { audit: { action: 'ban_source.create', resource: 'ban_source' } },
    },
    async (req, reply) => {
      if (denyManage(req, reply)) return;
      if (req.body.on_match === 'kick' && req.body.trust_level !== 'trusted') {
        reply.code(422);
        return { error: 'kick_requires_trusted_source' };
      }
      const id = uuidv7();
      const authHeaderEncrypted =
        req.body.auth_header != null
          ? serialize(encrypt(app.encryptionKey, req.body.auth_header))
          : null;
      await app.db.insert(externalBanSources).values({
        id,
        name: req.body.name,
        url: req.body.url,
        format: req.body.format,
        trustLevel: req.body.trust_level,
        onMatch: req.body.on_match,
        discordUrl: req.body.discord_url ?? null,
        authHeaderEncrypted,
        enabled: req.body.enabled,
        pollIntervalMinutes: req.body.poll_interval_minutes,
        parserConfig: req.body.parser_config ?? {},
      });
      const created = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, id))
        .limit(1)) as unknown as SourceRow[];
      // biome-ignore lint/style/noNonNullAssertion: row was just inserted
      const publicSource = toPublic(created[0]!, 0);
      req.auditSnapshots = { targetId: id, after: auditSnapshot(publicSource) };
      reply.code(201);
      return publicSource;
    },
  );

  fast.put(
    '/api/v1/ban-sources/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: { audit: { action: 'ban_source.update', resource: 'ban_source' } },
    },
    async (req, reply) => {
      if (denyManage(req, reply)) return;
      const existing = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1)) as unknown as SourceRow[];
      const before = existing[0];
      if (!before) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      const updates: Record<string, unknown> = {};
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.url !== undefined) updates.url = req.body.url;
      if (req.body.format !== undefined) updates.format = req.body.format;
      if (req.body.trust_level !== undefined) updates.trustLevel = req.body.trust_level;
      if (req.body.on_match !== undefined) updates.onMatch = req.body.on_match;
      if (req.body.discord_url !== undefined) updates.discordUrl = req.body.discord_url;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.poll_interval_minutes !== undefined)
        updates.pollIntervalMinutes = req.body.poll_interval_minutes;
      if (req.body.parser_config !== undefined) updates.parserConfig = req.body.parser_config;
      if (req.body.auth_header !== undefined) {
        updates.authHeaderEncrypted =
          req.body.auth_header === null
            ? null
            : serialize(encrypt(app.encryptionKey, req.body.auth_header));
      }
      if (Object.keys(updates).length > 0) {
        const nextTrustLevel = req.body.trust_level ?? before.trustLevel;
        const nextOnMatch = req.body.on_match ?? before.onMatch;
        if (nextOnMatch === 'kick' && nextTrustLevel !== 'trusted') {
          reply.code(422);
          return { error: 'kick_requires_trusted_source' };
        }
        await app.db
          .update(externalBanSources)
          .set(updates)
          .where(eq(externalBanSources.id, req.params.id));
        await app.redis.incr(EXTERNAL_BAN_CACHE_VERSION_KEY);
      }
      const refreshed = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1)) as unknown as SourceRow[];
      const recordCount = await recordCountFor(req.params.id);
      const beforePublic = toPublic(before, recordCount);
      // biome-ignore lint/style/noNonNullAssertion: row exists (guarded above)
      const afterPublic = toPublic(refreshed[0]!, recordCount);
      req.auditSnapshots = {
        before: auditSnapshot(beforePublic),
        after: auditSnapshot(afterPublic),
      };
      return afterPublic;
    },
  );

  fast.delete(
    '/api/v1/ban-sources/:id',
    {
      schema: { params: idParam },
      config: { audit: { action: 'ban_source.delete', resource: 'ban_source' } },
    },
    async (req, reply) => {
      if (denyManage(req, reply)) return;
      const existing = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1)) as unknown as SourceRow[];
      const target = existing[0];
      if (!target) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      req.auditSnapshots = { before: auditSnapshot(toPublic(target, 0)) };
      await app.db.delete(externalBanSources).where(eq(externalBanSources.id, req.params.id));
      await app.redis.incr(EXTERNAL_BAN_CACHE_VERSION_KEY);
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/ban-sources/:id/sync',
    {
      schema: { params: idParam },
      config: { audit: { action: 'ban_source.sync', resource: 'ban_source' } },
    },
    async (req, reply) => {
      if (denyManage(req, reply)) return;
      const existing = (await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1)) as unknown as SourceRow[];
      if (!existing[0]) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      const enqueuedAt = new Date().toISOString();
      await app.redis.xadd(
        'bansync:manual',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'job',
        JSON.stringify({
          source_id: req.params.id,
          actor_player_id: req.user?.playerId ?? null,
          request_id: req.id,
          enqueued_at: enqueuedAt,
        }),
      );
      return { ok: true, queued: true };
    },
  );
};

export default banSourcesRoutes;
