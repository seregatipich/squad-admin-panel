import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const SORTS = ['tk_7d', 'tk_30d', 'total'] as const;
const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;
const RECENT_LIMIT_DEFAULT = 10;

const summaryQuery = z.object({
  serverId: z.string().uuid().optional(),
  sort: z.enum(SORTS).default('tk_7d'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
});

const playerParams = z.object({ playerId: z.string().uuid() });
const playerQuery = z.object({
  serverId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(RECENT_LIMIT_DEFAULT),
});

type SummaryQuery = z.infer<typeof summaryQuery>;
type PlayerQuery = z.infer<typeof playerQuery>;

type TeamkillStatsRow = Record<string, unknown> & {
  player_id: string;
  current_name: string | null;
  steam_id64: bigint | string | null;
  eos_id: string | null;
  tk_total: number | string | bigint | null;
  tk_7d: number | string | bigint | null;
  tk_30d: number | string | bigint | null;
  victim_of_tk_total: number | string | bigint | null;
  last_tk_at: Date | string | null;
  moderation_total: number | string | bigint | null;
  last_moderation_at: Date | string | null;
  last_moderation_type: string | null;
};

type TeamkillEventRow = Record<string, unknown> & {
  id: bigint | number | string;
  server_id: string;
  match_id: bigint | number | string | null;
  weapon: string | null;
  occurred_at: Date | string;
  role: 'attacker' | 'victim';
  attacker_player_id: string | null;
  attacker_name: string | null;
  victim_player_id: string | null;
  victim_name: string | null;
};

function combatGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.combatView) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function toNumber(value: number | string | bigint | null): number {
  if (value == null) return 0;
  return Number(value);
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toStringOrNull(value: bigint | string | null): string | null {
  return value == null ? null : value.toString();
}

function normalizeStats(row: TeamkillStatsRow) {
  return {
    player_id: row.player_id,
    current_name: row.current_name,
    steam_id64: toStringOrNull(row.steam_id64),
    eos_id: row.eos_id,
    tk_total: toNumber(row.tk_total),
    tk_7d: toNumber(row.tk_7d),
    tk_30d: toNumber(row.tk_30d),
    victim_of_tk_total: toNumber(row.victim_of_tk_total),
    last_tk_at: toIso(row.last_tk_at),
    moderation_total: toNumber(row.moderation_total),
    last_moderation_at: toIso(row.last_moderation_at),
    last_moderation_type: row.last_moderation_type,
  };
}

function normalizeEvent(row: TeamkillEventRow) {
  return {
    id: Number(row.id),
    server_id: row.server_id,
    match_id: row.match_id == null ? null : Number(row.match_id),
    weapon: row.weapon,
    occurred_at: toIso(row.occurred_at),
    role: row.role,
    attacker: row.attacker_player_id
      ? { player_id: row.attacker_player_id, current_name: row.attacker_name }
      : null,
    victim: row.victim_player_id
      ? { player_id: row.victim_player_id, current_name: row.victim_name }
      : null,
  };
}

function sortSql(sort: SummaryQuery['sort']) {
  switch (sort) {
    case 'tk_30d':
      return sql`o.tk_30d`;
    case 'total':
      return sql`o.tk_total`;
    default:
      return sql`o.tk_7d`;
  }
}

function orderSql(order: SummaryQuery['order']) {
  return order === 'asc' ? sql`ASC` : sql`DESC`;
}

function serverFilter(serverId: string | undefined) {
  return serverId ? sql`AND ce.server_id = ${serverId}::uuid` : sql``;
}

async function loadSummaryRows(app: Parameters<FastifyPluginAsync>[0], query: SummaryQuery) {
  const rows = await app.db.execute<TeamkillStatsRow>(sql`
    WITH offenders AS (
      SELECT
        ce.attacker_player_id AS player_id,
        COUNT(*)::int AS tk_total,
        COUNT(*) FILTER (WHERE ce.occurred_at >= now() - interval '7 days')::int AS tk_7d,
        COUNT(*) FILTER (WHERE ce.occurred_at >= now() - interval '30 days')::int AS tk_30d,
        MAX(ce.occurred_at) AS last_tk_at
      FROM combat_events ce
      WHERE ce.is_teamkill
        AND ce.attacker_player_id IS NOT NULL
        ${serverFilter(query.serverId)}
      GROUP BY ce.attacker_player_id
    ),
    victims AS (
      SELECT
        ce.victim_player_id AS player_id,
        COUNT(*)::int AS victim_of_tk_total
      FROM combat_events ce
      WHERE ce.is_teamkill
        AND ce.victim_player_id IS NOT NULL
        ${serverFilter(query.serverId)}
      GROUP BY ce.victim_player_id
    ),
    moderation AS (
      SELECT
        ma.player_id,
        COUNT(*)::int AS moderation_total,
        MAX(ma.created_at) AS last_moderation_at
      FROM moderation_actions ma
      WHERE ma.reverted_at IS NULL
      GROUP BY ma.player_id
    ),
    latest_moderation AS (
      SELECT DISTINCT ON (ma.player_id)
        ma.player_id,
        ma.action_type AS last_moderation_type
      FROM moderation_actions ma
      WHERE ma.reverted_at IS NULL
      ORDER BY ma.player_id, ma.created_at DESC, ma.id DESC
    )
    SELECT
      o.player_id,
      p.canonical_name AS current_name,
      p.steam_id64,
      p.eos_id,
      o.tk_total,
      o.tk_7d,
      o.tk_30d,
      COALESCE(v.victim_of_tk_total, 0)::int AS victim_of_tk_total,
      o.last_tk_at,
      COALESCE(m.moderation_total, 0)::int AS moderation_total,
      m.last_moderation_at,
      lm.last_moderation_type
    FROM offenders o
    INNER JOIN players p ON p.id = o.player_id
    LEFT JOIN victims v ON v.player_id = o.player_id
    LEFT JOIN moderation m ON m.player_id = o.player_id
    LEFT JOIN latest_moderation lm ON lm.player_id = o.player_id
    ORDER BY ${sortSql(query.sort)} ${orderSql(query.order)}, o.last_tk_at DESC, o.player_id ASC
    LIMIT ${query.limit}
  `);
  return rows.map(normalizeStats);
}

async function loadPlayerStats(
  app: Parameters<FastifyPluginAsync>[0],
  playerId: string,
  query: PlayerQuery,
) {
  const rows = await app.db.execute<TeamkillStatsRow>(sql`
    SELECT
      p.id AS player_id,
      p.canonical_name AS current_name,
      p.steam_id64,
      p.eos_id,
      COALESCE(off.tk_total, 0)::int AS tk_total,
      COALESCE(off.tk_7d, 0)::int AS tk_7d,
      COALESCE(off.tk_30d, 0)::int AS tk_30d,
      COALESCE(victim.victim_of_tk_total, 0)::int AS victim_of_tk_total,
      off.last_tk_at,
      COALESCE(moderation.moderation_total, 0)::int AS moderation_total,
      moderation.last_moderation_at,
      latest_moderation.last_moderation_type
    FROM players p
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS tk_total,
        COUNT(*) FILTER (WHERE ce.occurred_at >= now() - interval '7 days')::int AS tk_7d,
        COUNT(*) FILTER (WHERE ce.occurred_at >= now() - interval '30 days')::int AS tk_30d,
        MAX(ce.occurred_at) AS last_tk_at
      FROM combat_events ce
      WHERE ce.is_teamkill
        AND ce.attacker_player_id = p.id
        ${serverFilter(query.serverId)}
    ) off ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS victim_of_tk_total
      FROM combat_events ce
      WHERE ce.is_teamkill
        AND ce.victim_player_id = p.id
        ${serverFilter(query.serverId)}
    ) victim ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS moderation_total,
        MAX(ma.created_at) AS last_moderation_at
      FROM moderation_actions ma
      WHERE ma.player_id = p.id
        AND ma.reverted_at IS NULL
    ) moderation ON true
    LEFT JOIN LATERAL (
      SELECT ma.action_type AS last_moderation_type
      FROM moderation_actions ma
      WHERE ma.player_id = p.id
        AND ma.reverted_at IS NULL
      ORDER BY ma.created_at DESC, ma.id DESC
      LIMIT 1
    ) latest_moderation ON true
    WHERE p.id = ${playerId}::uuid
    LIMIT 1
  `);
  return rows[0] ? normalizeStats(rows[0]) : null;
}

async function loadRecentEvents(
  app: Parameters<FastifyPluginAsync>[0],
  playerId: string,
  query: PlayerQuery,
) {
  const rows = await app.db.execute<TeamkillEventRow>(sql`
    SELECT
      ce.id,
      ce.server_id,
      ce.match_id,
      ce.weapon,
      ce.occurred_at,
      CASE WHEN ce.attacker_player_id = ${playerId}::uuid THEN 'attacker' ELSE 'victim' END AS role,
      ce.attacker_player_id,
      attacker.canonical_name AS attacker_name,
      ce.victim_player_id,
      victim.canonical_name AS victim_name
    FROM combat_events ce
    LEFT JOIN players attacker ON attacker.id = ce.attacker_player_id
    LEFT JOIN players victim ON victim.id = ce.victim_player_id
    WHERE ce.is_teamkill
      AND (ce.attacker_player_id = ${playerId}::uuid OR ce.victim_player_id = ${playerId}::uuid)
      ${serverFilter(query.serverId)}
    ORDER BY ce.occurred_at DESC, ce.id DESC
    LIMIT ${query.limit}
  `);
  return rows.map(normalizeEvent);
}

const teamkillsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/moderation/teamkills',
    { schema: { querystring: summaryQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = combatGuard(req, reply);
      if (denied) return denied;

      return {
        generated_at: new Date().toISOString(),
        rows: await loadSummaryRows(app, req.query),
      };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/teamkills',
    {
      schema: { params: playerParams, querystring: playerQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = combatGuard(req, reply);
      if (denied) return denied;

      const stats = await loadPlayerStats(app, req.params.playerId, req.query);
      if (!stats) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      return {
        stats,
        recent: await loadRecentEvents(app, req.params.playerId, req.query),
      };
    },
  );
};

export default teamkillsRoutes;
