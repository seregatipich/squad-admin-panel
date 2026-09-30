import { type ExternalBanSourceRow, externalBanSources, externalBans } from '@squad/db/schema';
import { checkOutboundUrl } from '@squad/shared-config';
import {
  BAN_SYNC_MANUAL_DEDUP_SECONDS,
  BAN_SYNC_MANUAL_STREAM,
  banSyncManualPendingKey,
  EXTERNAL_BAN_CACHE_VERSION_KEY,
} from '@squad/shared-types';
import { and, eq, isNull, sql } from 'drizzle-orm';
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

/** Discord invite rendered as a link in the UI: https only (#104). */
const discordUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === 'https:', 'discord_url must use https');

const FIELD_PATH_KEYS = [
  'steam_id64',
  'eos_id',
  'nickname',
  'reason',
  'admin_name',
  'issued_at',
  'expires_at',
] as const;

/** Flags every recognised `parser_config.fields` entry whose dot-path is not a string. */
function requireStringFieldPaths(fields: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of FIELD_PATH_KEYS) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'must be a dot-path string',
      });
    }
  }
}

/**
 * Shape of a source's `parser_config` as `worker-ban-sync` reads it
 * (`readPathConfig` / `readCsvConfig` in the worker's adapters). Typed keys are
 * checked here so a bad value is rejected when the source is saved rather than
 * failing every sync; unknown keys pass through unchanged for compatibility
 * with configs already stored.
 */
const parserConfig = z
  .object({
    list_path: z.string().optional(),
    fields: z.object({}).catchall(z.unknown()).superRefine(requireStringFieldPaths).optional(),
    csv: z
      .object({
        delimiter: z.string().length(1).optional(),
        has_header: z.boolean().optional(),
        columns: z.record(z.union([z.number(), z.string()])).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const createBody = z.object({
  name: z.string().trim().min(1).max(128),
  url: sourceUrl,
  format: z.enum(BAN_SOURCE_FORMATS),
  trust_level: z.enum(TRUST_LEVELS).default('normal'),
  on_match: z.enum(ON_MATCH_ACTIONS).default('alert'),
  discord_url: discordUrl.nullable().optional(),
  auth_header: z.string().min(1).max(1024).nullable().optional(),
  enabled: z.boolean().default(true),
  poll_interval_minutes: z.number().int().min(15).max(10080).default(60),
  parser_config: parserConfig.optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  url: sourceUrl.optional(),
  format: z.enum(BAN_SOURCE_FORMATS).optional(),
  trust_level: z.enum(TRUST_LEVELS).optional(),
  on_match: z.enum(ON_MATCH_ACTIONS).optional(),
  discord_url: discordUrl.nullable().optional(),
  auth_header: z.string().min(1).max(1024).nullable().optional(),
  enabled: z.boolean().optional(),
  poll_interval_minutes: z.number().int().min(15).max(10080).optional(),
  parser_config: parserConfig.optional(),
});

const idParam = z.object({ id: z.string().uuid() });

/**
 * The feed URL as shown to panel users and written to audit snapshots (#103):
 * every query-parameter value is replaced by `***`, since feeds such as
 * BattleMetrics carry their API key there. The worker reads the real URL from
 * the database.
 */
function maskFeedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.search === '') return url;
  const masked = new URLSearchParams();
  for (const key of parsed.searchParams.keys()) masked.append(key, '***');
  parsed.search = masked.toString().replaceAll('%2A', '*');
  return parsed.toString();
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

function toPublic(row: ExternalBanSourceRow, recordCount: number): PublicSource {
  return {
    id: row.id,
    name: row.name,
    url: maskFeedUrl(row.url),
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

  // Only active records count (#107): ban-sync never deletes an entry that
  // left the feed, it stamps `revoked_at`. Served by the partial index
  // external_bans_active_source_idx.
  async function recordCounts(): Promise<Map<string, number>> {
    const rows = await app.db
      .select({ sourceId: externalBans.sourceId, count: sql<number>`count(*)::int` })
      .from(externalBans)
      .where(isNull(externalBans.revokedAt))
      .groupBy(externalBans.sourceId);
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.sourceId, Number(row.count));
    return map;
  }

  async function recordCountFor(sourceId: string): Promise<number> {
    const rows = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(externalBans)
      .where(and(eq(externalBans.sourceId, sourceId), isNull(externalBans.revokedAt)));
    return Number(rows[0]?.count ?? 0);
  }

  fast.get(
    '/api/v1/ban-sources',
    { config: { audit: false, permissions: ['ban_source:view'] } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      const sources = await app.db
        .select()
        .from(externalBanSources)
        .orderBy(externalBanSources.createdAt);
      const counts = await recordCounts();
      return sources.map((source) => toPublic(source, counts.get(source.id) ?? 0));
    },
  );

  // Picker feed for the registry filter: id and name only, so a page that just
  // needs a dropdown does not pay for the `external_bans` aggregate (#561).
  fast.get(
    '/api/v1/ban-sources/options',
    { config: { audit: false, permissions: ['ban_source:view'] } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      return app.db
        .select({ id: externalBanSources.id, name: externalBanSources.name })
        .from(externalBanSources)
        .orderBy(externalBanSources.createdAt);
    },
  );

  fast.get(
    '/api/v1/ban-sources/:id',
    { schema: { params: idParam }, config: { audit: false, permissions: ['ban_source:view'] } },
    async (req, reply) => {
      if (denyRead(req, reply)) return;
      const [source] = await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1);
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
      const [created] = await app.db
        .insert(externalBanSources)
        .values({
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
        })
        .returning();
      if (!created) throw new Error('external_ban_sources insert returned no row');
      const publicSource = toPublic(created, 0);
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
      const [before] = await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1);
      if (!before) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      const updates: Partial<typeof externalBanSources.$inferInsert> = {};
      if (req.body.name !== undefined) updates.name = req.body.name;
      // A client that echoes the masked URL from a GET is not changing it.
      if (req.body.url !== undefined && req.body.url !== maskFeedUrl(before.url)) {
        updates.url = req.body.url;
      }
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
      const [refreshed] = await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1);
      if (!refreshed) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      const recordCount = await recordCountFor(req.params.id);
      const beforePublic = toPublic(before, recordCount);
      const afterPublic = toPublic(refreshed, recordCount);
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
      const [target] = await app.db
        .select()
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1);
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
      const [existing] = await app.db
        .select({ id: externalBanSources.id })
        .from(externalBanSources)
        .where(eq(externalBanSources.id, req.params.id))
        .limit(1);
      if (!existing) {
        reply.code(404);
        return { error: 'ban_source_not_found' };
      }
      const claimed = await app.redis.set(
        banSyncManualPendingKey(req.params.id),
        req.id,
        'EX',
        BAN_SYNC_MANUAL_DEDUP_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') {
        reply.code(409);
        return { error: 'sync_already_queued' };
      }
      const enqueuedAt = new Date().toISOString();
      await app.redis.xadd(
        BAN_SYNC_MANUAL_STREAM,
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
