import { externalBanSources, externalBans, players } from '@squad/db/schema';
import { desc, eq, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const playerIdParams = z.object({ playerId: z.string().uuid() });

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
 * CBAN-3: read-only aggregation surface over `external_bans` (CBAN-1/CBAN-2).
 * Two routes, both gated on `panel_access`:
 *  - per-player aggregate for the "Внешние банлисты" player-card section
 *  - a registry-wide search/browse list for the `/external-bans` page
 * Neither route mutates data, so both opt out of the audit hook.
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
