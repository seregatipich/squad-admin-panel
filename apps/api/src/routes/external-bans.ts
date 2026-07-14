import {
  events,
  externalBanSources,
  externalBans,
  moderationActions,
  players,
  servers,
} from '@squad/db/schema';
import { type EventEnvelope, moderationActionPayload, STREAM_NAME } from '@squad/shared-types';
import { and, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const localBanParams = z.object({
  playerId: z.string().uuid(),
  externalBanId: z.string().uuid(),
});
const localBanBody = z.object({
  server_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(300),
  ban_length: z
    .string()
    .trim()
    .regex(/^\d+[smhdwMy]?$/, 'invalid ban_length')
    .default('0'),
});

const registryQuery = z.object({
  q: z.string().trim().min(1).max(256).optional(),
  permanent_only: z.enum(['true', 'false']).optional(),
  source_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

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

function localBanGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  const denied = panelGuard(req, reply);
  if (denied) return denied;
  if (!req.user?.permissions.squadPermissions.has('ban')) {
    reply.code(403);
    return { error: 'forbidden', required: 'ban' };
  }
  return null;
}

interface PlayerBanRow {
  id: string;
  sourceId: string;
  sourceName: string;
  trustLevel: string;
  discordUrl: string | null;
  nickname: string | null;
  reason: string | null;
  adminName: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, evaluated in TS. */
function isActiveBan(expiresAt: Date | null, revokedAt: Date | null): boolean {
  if (revokedAt !== null) return false;
  if (expiresAt === null) return true;
  return expiresAt.getTime() > Date.now();
}

interface RegistryBanJson {
  id: string;
  source_id: string;
  source_name: string;
  trust_level: string;
  discord_url: string | null;
  nickname: string | null;
  reason: string | null;
  admin_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

interface RegistryRow {
  steam_id64: string | null;
  eos_id: string | null;
  bans: RegistryBanJson[];
  player_id: string | null;
  panel_nickname: string | null;
  total_count: string | number;
}

/**
 * External-ban aggregation and enforcement surface over `external_bans`.
 * CBAN-3 provides two reads gated on `panel_access`:
 *  - per-player aggregate for the "Внешние банлисты" player-card section
 *  - a registry-wide search/browse list for the `/external-bans` page
 * CBAN-4 adds an explicit local-ban mutation for active player matches. That
 * mutation additionally requires the Squad `ban` permission and records its
 * own audit entry after successful RCON enforcement.
 */
const externalBansRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/external-bans',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const [player] = await app.db
        .select({ steamId64: players.steamId64, eosId: players.eosId })
        .from(players)
        .where(eq(players.id, req.params.playerId))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const steamId64 = player.steamId64 !== null ? player.steamId64.toString() : null;
      const eosId = player.eosId;

      const conditions: SQL[] = [];
      if (steamId64 !== null) conditions.push(eq(externalBans.steamId64, steamId64));
      if (eosId !== null) conditions.push(eq(externalBans.eosId, eosId));

      if (conditions.length === 0) {
        return { sources: [], active_source_count: 0, total: 0 };
      }

      const rows = (await app.db
        .select({
          id: externalBans.id,
          sourceId: externalBans.sourceId,
          sourceName: externalBanSources.name,
          trustLevel: externalBanSources.trustLevel,
          discordUrl: externalBanSources.discordUrl,
          nickname: externalBans.nickname,
          reason: externalBans.reason,
          adminName: externalBans.adminName,
          issuedAt: externalBans.issuedAt,
          expiresAt: externalBans.expiresAt,
          revokedAt: externalBans.revokedAt,
        })
        .from(externalBans)
        .innerJoin(externalBanSources, eq(externalBanSources.id, externalBans.sourceId))
        .where(or(...conditions))
        .orderBy(externalBanSources.name, desc(externalBans.issuedAt))) as PlayerBanRow[];

      interface SourceGroup {
        source: { id: string; name: string; trust_level: string; discord_url: string | null };
        bans: Array<{
          id: string;
          nickname: string | null;
          reason: string | null;
          admin_name: string | null;
          issued_at: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          is_active: boolean;
          is_permanent: boolean;
        }>;
        active_count: number;
      }

      const bySource = new Map<string, SourceGroup>();
      const order: string[] = [];
      for (const row of rows) {
        let group = bySource.get(row.sourceId);
        if (!group) {
          group = {
            source: {
              id: row.sourceId,
              name: row.sourceName,
              trust_level: row.trustLevel,
              discord_url: row.discordUrl,
            },
            bans: [],
            active_count: 0,
          };
          bySource.set(row.sourceId, group);
          order.push(row.sourceId);
        }
        const active = isActiveBan(row.expiresAt, row.revokedAt);
        if (active) group.active_count += 1;
        group.bans.push({
          id: row.id,
          nickname: row.nickname,
          reason: row.reason,
          admin_name: row.adminName,
          issued_at: row.issuedAt ? row.issuedAt.toISOString() : null,
          expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
          revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
          is_active: active,
          is_permanent: row.expiresAt === null,
        });
      }

      const sources = order.map((id) => {
        // biome-ignore lint/style/noNonNullAssertion: id comes from bySource's own keys
        const group = bySource.get(id)!;
        return {
          source: group.source,
          bans: group.bans,
          active_count: group.active_count,
        };
      });

      return {
        sources,
        active_source_count: sources.filter((s) => s.active_count > 0).length,
        total: rows.length,
      };
    },
  );

  /**
   * Converts one active external-ban match into an explicit local AdminBan.
   * The moderator chooses the target server and can edit the prefilled reason
   * in the player-card form; successful enforcement is recorded in the
   * moderation ledger, audit log, and EVT-1 stream consumed by DISCORD-2.
   */
  fast.post(
    '/api/v1/players/:playerId/external-bans/:externalBanId/local-ban',
    { schema: { params: localBanParams, body: localBanBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = localBanGuard(req, reply);
      if (denied) return denied;

      const [player] = await app.db
        .select({
          steamId64: players.steamId64,
          eosId: players.eosId,
          name: players.canonicalName,
        })
        .from(players)
        .where(eq(players.id, req.params.playerId))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const [externalBan] = await app.db
        .select({
          id: externalBans.id,
          sourceId: externalBans.sourceId,
          sourceName: externalBanSources.name,
          steamId64: externalBans.steamId64,
          eosId: externalBans.eosId,
          expiresAt: externalBans.expiresAt,
          revokedAt: externalBans.revokedAt,
        })
        .from(externalBans)
        .innerJoin(externalBanSources, eq(externalBanSources.id, externalBans.sourceId))
        .where(eq(externalBans.id, req.params.externalBanId))
        .limit(1);

      const steamId64 = player.steamId64?.toString() ?? null;
      const belongsToPlayer =
        externalBan !== undefined &&
        ((steamId64 !== null && externalBan.steamId64 === steamId64) ||
          (player.eosId !== null && externalBan.eosId === player.eosId));
      if (!externalBan || !belongsToPlayer) {
        reply.code(404);
        return { error: 'external_ban_not_found' };
      }
      if (!isActiveBan(externalBan.expiresAt, externalBan.revokedAt)) {
        reply.code(409);
        return { error: 'external_ban_inactive' };
      }

      const [server] = await app.db
        .select({ id: servers.id, name: servers.displayName })
        .from(servers)
        .where(and(eq(servers.id, req.body.server_id), isNull(servers.deletedAt)))
        .limit(1);
      if (!server) {
        reply.code(404);
        return { error: 'server_not_found' };
      }

      const target = player.eosId ?? steamId64;
      if (!target) {
        reply.code(400);
        return { error: 'target_identity_missing' };
      }

      // biome-ignore lint/style/noNonNullAssertion: localBanGuard rejects unauthenticated callers
      const actorPlayerId = req.user!.playerId;
      const outcome = await sendRconCommandViaWorker(app.redis, {
        serverId: server.id,
        command: 'AdminBan',
        args: [target, req.body.ban_length, req.body.reason],
        actorPlayerId,
      });
      if (!outcome.attempted || !outcome.ok) {
        reply.code(502);
        return {
          error: 'action_failed',
          reason: outcome.reason,
          detail: outcome.attempted ? outcome.detail : undefined,
        };
      }

      const [action] = await app.db
        .insert(moderationActions)
        .values({
          playerId: req.params.playerId,
          serverId: server.id,
          actionType: 'ban',
          authorPlayerId: actorPlayerId,
          reason: req.body.reason,
          context: {
            ban_length: req.body.ban_length,
            external_ban_id: externalBan.id,
            source_id: externalBan.sourceId,
            source_name: externalBan.sourceName,
          },
        })
        .returning({ id: moderationActions.id, createdAt: moderationActions.createdAt });
      if (!action) throw new Error('moderation action insert returned no row');

      const payload = moderationActionPayload.parse({
        moderation_action_id: action.id,
        action_type: 'ban',
        player_id: req.params.playerId,
        steam_id64: steamId64,
        eos_id: player.eosId,
        name: player.name,
        reason: req.body.reason,
        duration: req.body.ban_length,
        actor_name: req.user?.canonicalName,
        report_id: null,
      });
      const envelope: EventEnvelope = {
        event_id: uuidv7(),
        version: 1,
        type: 'moderation.ban',
        server_id: server.id,
        ts: new Date().toISOString(),
        actor: { kind: 'user', id: actorPlayerId },
        correlation_id: externalBan.id,
        payload,
      };
      await app.db.insert(events).values({
        eventId: envelope.event_id,
        serverId: envelope.server_id,
        occurredAt: new Date(envelope.ts),
        kind: envelope.type,
        version: envelope.version,
        actorKind: envelope.actor?.kind ?? null,
        actorId: envelope.actor?.id ?? null,
        correlationId: envelope.correlation_id,
        payload: envelope.payload,
      });
      await app.redis.xadd(
        STREAM_NAME.eventsServer(server.id),
        'MAXLEN',
        '~',
        '10000',
        '*',
        'envelope',
        JSON.stringify(envelope),
      );

      await writeAuditEntry(app.db, {
        actor: {
          kind: 'steam',
          playerId: actorPlayerId,
          tokenId: req.apiTokenId ?? null,
        },
        actorIp: req.ip ?? null,
        actionType: 'external_ban.local_ban',
        targetType: 'player',
        targetId: req.params.playerId,
        after: {
          action_type: 'ban',
          reason: req.body.reason,
          ban_length: req.body.ban_length,
          server_id: server.id,
          external_ban_id: externalBan.id,
          source_id: externalBan.sourceId,
        },
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });

      return {
        id: action.id,
        action_type: 'ban',
        reason: req.body.reason,
        duration: req.body.ban_length,
        created_at: action.createdAt.toISOString(),
        server: { id: server.id, name: server.name },
        external_ban_id: externalBan.id,
      };
    },
  );

  fast.get(
    '/api/v1/external-bans',
    { schema: { querystring: registryQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { q, permanent_only, source_id, limit, offset } = req.query;

      const conditions: SQL[] = [];
      if (q) {
        const pattern = `%${q}%`;
        conditions.push(
          sql`(eb.nickname ILIKE ${pattern} OR eb.reason ILIKE ${pattern} OR eb.steam_id64 ILIKE ${pattern} OR eb.eos_id ILIKE ${pattern})`,
        );
      }
      if (permanent_only === 'true') {
        conditions.push(sql`eb.expires_at IS NULL`);
      }
      if (source_id) {
        conditions.push(sql`eb.source_id = ${source_id}`);
      }
      const whereClause =
        conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const rows = (await app.db.execute(sql`
        WITH filtered AS (
          SELECT eb.id, eb.source_id, ebs.name AS source_name, ebs.trust_level, ebs.discord_url,
                 eb.steam_id64, eb.eos_id, eb.nickname, eb.reason, eb.admin_name,
                 eb.issued_at, eb.expires_at, eb.revoked_at, eb.imported_at
          FROM external_bans eb
          INNER JOIN external_ban_sources ebs ON ebs.id = eb.source_id
          ${whereClause}
        ),
        grouped AS (
          SELECT
            coalesce(steam_id64, '') AS identity_steam_key,
            coalesce(eos_id, '') AS identity_eos_key,
            max(steam_id64) AS steam_id64,
            max(eos_id) AS eos_id,
            max(imported_at) AS last_imported_at,
            json_agg(
              json_build_object(
                'id', id,
                'source_id', source_id,
                'source_name', source_name,
                'trust_level', trust_level,
                'discord_url', discord_url,
                'nickname', nickname,
                'reason', reason,
                'admin_name', admin_name,
                'issued_at', issued_at,
                'expires_at', expires_at,
                'revoked_at', revoked_at
              ) ORDER BY issued_at DESC NULLS LAST
            ) AS bans
          FROM filtered
          GROUP BY identity_steam_key, identity_eos_key
        )
        SELECT
          g.steam_id64,
          g.eos_id,
          g.bans,
          p.id AS player_id,
          p.canonical_name AS panel_nickname,
          count(*) OVER () AS total_count
        FROM grouped g
        LEFT JOIN players p
          ON (g.steam_id64 IS NOT NULL AND p.steam_id64::text = g.steam_id64)
          OR (g.eos_id IS NOT NULL AND p.eos_id = g.eos_id)
        ORDER BY g.last_imported_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as RegistryRow[];

      const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;

      const items = rows.map((row) => {
        const bans = row.bans.map((ban) => {
          const expiresAt = ban.expires_at ? new Date(ban.expires_at) : null;
          const revokedAt = ban.revoked_at ? new Date(ban.revoked_at) : null;
          return {
            id: ban.id,
            source_id: ban.source_id,
            source_name: ban.source_name,
            trust_level: ban.trust_level,
            discord_url: ban.discord_url,
            nickname: ban.nickname,
            reason: ban.reason,
            admin_name: ban.admin_name,
            issued_at: ban.issued_at,
            expires_at: ban.expires_at,
            revoked_at: ban.revoked_at,
            is_active: isActiveBan(expiresAt, revokedAt),
            is_permanent: ban.expires_at === null,
          };
        });
        const activeSourceIds = new Set(bans.filter((b) => b.is_active).map((b) => b.source_id));
        return {
          steam_id64: row.steam_id64,
          eos_id: row.eos_id,
          player_id: row.player_id,
          panel_nickname: row.panel_nickname,
          bans,
          active_source_count: activeSourceIds.size,
        };
      });

      return { rows: items, total, limit, offset };
    },
  );
};

export default externalBansRoutes;
