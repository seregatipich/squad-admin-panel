import { bucketSessionsByLocalHour, computeKdRatio, computePrimetime } from '@squad/db';
import type { ClanRow } from '@squad/db/schema';
import {
  clanMembers,
  clans,
  matches,
  matchPlayers,
  playerDailyPresence,
  playerSessions,
  playerStatPeriods,
  players,
  roleSquadPermissions,
  servers,
} from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { writeAuditEntry } from '../lib/audit.js';

const NAME_MAX = 32;
const TAG_MAX = 32;
const TAGS_MAX = 16;
const DESCRIPTION_MAX = 2000;
const SLOTS_MAX = 999;
const RESERVE_SQUAD_PERMISSION_KEY = 'reserve';

const clanIdParams = z.object({ id: z.string().uuid() });

const MATCHES_LIMIT_DEFAULT = 20;
const MATCHES_LIMIT_MAX = 100;

const matchesQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MATCHES_LIMIT_MAX).default(MATCHES_LIMIT_DEFAULT),
  server_id: z.string().uuid().optional(),
});

interface MatchesCursor {
  v: number;
  id: string;
}

function encodeMatchesCursor(cursor: MatchesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function parseMatchesCursor(raw: string): MatchesCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as MatchesCursor;
    if (!decoded || typeof decoded !== 'object') return null;
    if (typeof decoded.v !== 'number' || !Number.isFinite(decoded.v)) return null;
    if (typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)) return null;
    return decoded;
  } catch {
    return null;
  }
}

const nameSchema = z.string().trim().min(1).max(NAME_MAX);
const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(TAG_MAX)
      .refine((tag) => !tag.includes(','), { message: 'tag_contains_comma' }),
  )
  .max(TAGS_MAX);
const slotsSchema = z.number().int().min(0).max(SLOTS_MAX);
const descriptionSchema = z.string().max(DESCRIPTION_MAX);

const createBody = z.object({
  name: nameSchema,
  description: descriptionSchema.nullish(),
  tags: tagsSchema.optional(),
  max_priority_slots: slotsSchema.optional(),
  primary_server_id: z.string().uuid().nullish(),
  is_public: z.boolean().optional(),
  is_tag_protected: z.boolean().optional(),
});

const updateBody = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    tags: tagsSchema.optional(),
    max_priority_slots: slotsSchema.optional(),
    primary_server_id: z.string().uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no_fields' });

const settingsBody = z
  .object({
    is_public: z.boolean().optional(),
    is_tag_protected: z.boolean().optional(),
  })
  .refine((body) => body.is_public !== undefined || body.is_tag_protected !== undefined, {
    message: 'no_fields',
  });

const expireBody = z.object({
  priority_expires_at: z.string().datetime({ offset: true }).nullable(),
});

const assignableMemberRole = z.enum(['deputy', 'member']);

const rosterQuery = z.object({
  q: z.string().trim().min(1).max(64).optional(),
  sort: z
    .enum(['name', 'role', 'priority', 'joined_at', 'last_seen', 'online'])
    .default('joined_at'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const addMemberBody = z.object({
  player_id: z.string().uuid(),
  member_role: assignableMemberRole.default('member'),
});

const setMemberRoleBody = z.object({ member_role: assignableMemberRole });

const transferBody = z.object({ player_id: z.string().uuid() });

const memberParams = z.object({ id: z.string().uuid(), playerId: z.string().uuid() });

const setPriorityBody = z.object({ enabled: z.boolean() });

const rosterExportQuery = z.object({ format: z.literal('csv').default('csv') });

/** Escapes a CSV field per RFC 4180 when it contains a comma, quote, or newline. */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface RosterRow {
  player_id: string;
  member_role: string;
  has_priority: boolean;
  joined_at: string;
  canonical_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  last_seen_at: string | null;
  online_60d: number;
  reserve_from_role: boolean;
}

function clanSnapshot(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function toClanDto(row: ClanRow) {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    description: row.description,
    max_priority_slots: row.maxPrioritySlots,
    priority_expires_at: row.priorityExpiresAt ? row.priorityExpiresAt.toISOString() : null,
    is_tag_protected: row.isTagProtected,
    is_public: row.isPublic,
    primary_server_id: row.primaryServerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Thrown inside the priority-toggle transaction to abort with a rollback when the pool is full. */
class PriorityPoolLimitError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super('priority_pool_limit');
  }
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const wrapped = err as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  return {
    code: wrapped.code ?? wrapped.cause?.code,
    constraint: wrapped.constraint_name ?? wrapped.cause?.constraint_name,
  };
}

function auditActor(req: FastifyRequest) {
  if (!req.user) throw new Error('audit actor requires an authenticated user');
  return { kind: 'steam' as const, playerId: req.user.playerId, tokenId: req.apiTokenId ?? null };
}

const STATS_DAY_MS = 86_400_000;
const STATS_DEFAULT_RANGE_DAYS = 30;
const STATS_TOP_MEMBERS_LIMIT = 10;
const STATS_SESSION_WINDOW_CAP = 5000;
const dayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const statsQuery = z.object({
  from: dayStringSchema.optional(),
  to: dayStringSchema.optional(),
});
const statsExportQuery = z.object({
  from: dayStringSchema.optional(),
  to: dayStringSchema.optional(),
  format: z.literal('csv').default('csv'),
});

function subtractDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) - days * STATS_DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Resolves the inclusive [fromDay, toDay] window for clan stats, defaulting to the trailing 30 days. */
function resolveStatsWindow(
  from: string | undefined,
  to: string | undefined,
): { fromDay: string; toDay: string } | null {
  const toDay = to ?? new Date().toISOString().slice(0, 10);
  const fromDay = from ?? subtractDays(toDay, STATS_DEFAULT_RANGE_DAYS - 1);
  if (fromDay > toDay) return null;
  return { fromDay, toDay };
}

interface ClanStatsChartPoint {
  day: string;
  online_seconds: number;
  boost_seconds: number;
}

interface ClanStatsServerTotal {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  online_seconds: number;
}

interface ClanStatsCombatMember {
  player_id: string;
  canonical_name: string;
  kills: number;
  deaths: number;
  revives: number;
  kd: number;
}

interface ClanStatsPayload {
  clan_id: string;
  from: string;
  to: string;
  roster_size: number;
  chart: ClanStatsChartPoint[];
  totals: {
    online_seconds: number;
    boost_seconds: number;
    primary_server: ClanStatsServerTotal | null;
  };
  primetime: {
    total_seconds: number;
    histogram: number[];
    rolling_average: number[];
    range: {
      label: string;
      start_minutes: number;
      end_minutes: number;
      start_hour: number;
      end_hour: number;
    } | null;
  };
  combat: {
    kills: number;
    deaths: number;
    revives: number;
    kd: number;
    top: ClanStatsCombatMember[];
  };
}

function emptyClanStatsPayload(clanId: string, fromDay: string, toDay: string): ClanStatsPayload {
  const chart: ClanStatsChartPoint[] = [];
  for (let cursor = fromDay; cursor <= toDay; cursor = subtractDays(cursor, -1)) {
    chart.push({ day: cursor, online_seconds: 0, boost_seconds: 0 });
  }
  return {
    clan_id: clanId,
    from: fromDay,
    to: toDay,
    roster_size: 0,
    chart,
    totals: { online_seconds: 0, boost_seconds: 0, primary_server: null },
    primetime: {
      total_seconds: 0,
      histogram: new Array(24).fill(0),
      rolling_average: new Array(24).fill(0),
      range: null,
    },
    combat: { kills: 0, deaths: 0, revives: 0, kd: 0, top: [] },
  };
}

const clansRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadActiveClan(id: string): Promise<ClanRow | null> {
    const rows = await app.db
      .select()
      .from(clans)
      .where(and(eq(clans.id, id), isNull(clans.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function membershipRole(clanId: string, playerId: string): Promise<string | null> {
    const rows = await app.db
      .select({ role: clanMembers.memberRole })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clanId), eq(clanMembers.playerId, playerId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  async function clanManageLevel(
    clanId: string,
    user: NonNullable<FastifyRequest['user']>,
  ): Promise<'full' | 'deputy' | null> {
    if (user.permissions.canManageClans) return 'full';
    const role = await membershipRole(clanId, user.playerId);
    if (role === 'leader') return 'full';
    if (role === 'deputy') return 'deputy';
    return null;
  }

  fast.get('/api/v1/clans', { config: { audit: false } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    if (!req.user.permissions.panelAccess) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    const rows = await app.db
      .select({
        id: clans.id,
        name: clans.name,
        tags: clans.tags,
        description: clans.description,
        maxPrioritySlots: clans.maxPrioritySlots,
        priorityExpiresAt: clans.priorityExpiresAt,
        isTagProtected: clans.isTagProtected,
        isPublic: clans.isPublic,
        primaryServerId: clans.primaryServerId,
        createdAt: clans.createdAt,
        updatedAt: clans.updatedAt,
        memberCount: sql<number>`(SELECT count(*) FROM clan_members m WHERE m.clan_id = ${clans.id})`,
        priorityCount: sql<number>`(SELECT count(*) FROM clan_members m WHERE m.clan_id = ${clans.id} AND m.has_priority)`,
      })
      .from(clans)
      .where(isNull(clans.deletedAt))
      .orderBy(asc(clans.name));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        tags: r.tags,
        description: r.description,
        max_priority_slots: r.maxPrioritySlots,
        priority_expires_at: r.priorityExpiresAt ? r.priorityExpiresAt.toISOString() : null,
        is_tag_protected: r.isTagProtected,
        is_public: r.isPublic,
        primary_server_id: r.primaryServerId,
        member_count: Number(r.memberCount),
        priority_count: Number(r.priorityCount),
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      })),
      total: rows.length,
    };
  });

  fast.get(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const members = await app.db
        .select({
          playerId: clanMembers.playerId,
          memberRole: clanMembers.memberRole,
          hasPriority: clanMembers.hasPriority,
          joinedAt: clanMembers.joinedAt,
          canonicalName: players.canonicalName,
          reserveFromRole: sql<boolean>`EXISTS (
            SELECT 1 FROM role_squad_permissions rsp
            WHERE rsp.role_id = ${players.roleId} AND rsp.squad_permission_key = ${RESERVE_SQUAD_PERMISSION_KEY}
          )`,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt));
      const priorityCount = members.filter((m) => m.hasPriority).length;
      return {
        ...toClanDto(clan),
        priority_count: priorityCount,
        members: members.map((m) => ({
          player_id: m.playerId,
          canonical_name: m.canonicalName,
          member_role: m.memberRole,
          has_priority: m.hasPriority,
          reserve_from_role: m.reserveFromRole,
          joined_at: m.joinedAt.toISOString(),
        })),
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id/online',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const rows = await app.db
        .select({
          serverId: playerSessions.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          playerId: players.id,
          canonicalName: players.canonicalName,
          connectedAt: playerSessions.connectedAt,
        })
        .from(clanMembers)
        .innerJoin(
          playerSessions,
          and(
            eq(playerSessions.playerId, clanMembers.playerId),
            isNull(playerSessions.disconnectedAt),
          ),
        )
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .innerJoin(servers, eq(servers.id, playerSessions.serverId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(servers.displayName), asc(playerSessions.connectedAt));

      const byServer = new Map<
        string,
        {
          server_id: string;
          server_name: string;
          server_slug: string;
          members: Array<{
            player_id: string;
            name: string;
            team: string | null;
            squad: string | null;
            session_started_at: string;
          }>;
        }
      >();
      for (const row of rows) {
        let group = byServer.get(row.serverId);
        if (!group) {
          group = {
            server_id: row.serverId,
            server_name: row.serverName,
            server_slug: row.serverSlug,
            members: [],
          };
          byServer.set(row.serverId, group);
        }
        group.members.push({
          player_id: row.playerId,
          name: row.canonicalName,
          team: null,
          squad: null,
          session_started_at: row.connectedAt.toISOString(),
        });
      }

      return { clan_id: clan.id, servers: Array.from(byServer.values()) };
    },
  );

  fast.get(
    '/api/v1/clans/:id/matches',
    { schema: { params: clanIdParams, querystring: matchesQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }

      const { limit, server_id: serverId } = req.query;
      const participationExists = sql`EXISTS (
        SELECT 1 FROM ${matchPlayers} mp
        JOIN ${clanMembers} cm ON cm.player_id = mp.player_id
        WHERE mp.match_id = ${matches.id} AND cm.clan_id = ${clan.id}
      )`;

      const clauses = [participationExists];
      if (serverId) clauses.push(eq(matches.serverId, serverId));

      if (req.query.cursor) {
        const cursor = parseMatchesCursor(req.query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const startedAt = new Date(cursor.v);
        const keyset = or(
          lt(matches.startedAt, startedAt),
          and(eq(matches.startedAt, startedAt), lt(matches.id, cursor.id)),
        );
        if (keyset) clauses.push(keyset);
      }

      const rows = await app.db
        .select({
          id: matches.id,
          serverId: matches.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          layer: matches.layer,
          map: matches.map,
          team1Faction: matches.team1Faction,
          team2Faction: matches.team2Faction,
          team1Tickets: matches.team1Tickets,
          team2Tickets: matches.team2Tickets,
          winner: matches.winner,
          isSeed: matches.isSeed,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          durationSeconds: matches.durationSeconds,
        })
        .from(matches)
        .leftJoin(servers, eq(servers.id, matches.serverId))
        .where(and(...clauses))
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last ? encodeMatchesCursor({ v: last.startedAt.getTime(), id: last.id }) : null;

      const participantsByMatch = new Map<
        string,
        Array<{ player_id: string; name: string; member_role: string }>
      >();
      if (page.length > 0) {
        const participantRows = await app.db
          .select({
            matchId: matchPlayers.matchId,
            playerId: players.id,
            canonicalName: players.canonicalName,
            memberRole: clanMembers.memberRole,
          })
          .from(matchPlayers)
          .innerJoin(
            clanMembers,
            and(eq(clanMembers.playerId, matchPlayers.playerId), eq(clanMembers.clanId, clan.id)),
          )
          .innerJoin(players, eq(players.id, matchPlayers.playerId))
          .where(
            inArray(
              matchPlayers.matchId,
              page.map((row) => row.id),
            ),
          )
          .orderBy(asc(players.canonicalName));
        for (const participant of participantRows) {
          let group = participantsByMatch.get(participant.matchId);
          if (!group) {
            group = [];
            participantsByMatch.set(participant.matchId, group);
          }
          group.push({
            player_id: participant.playerId,
            name: participant.canonicalName,
            member_role: participant.memberRole,
          });
        }
      }

      return {
        clan_id: clan.id,
        items: page.map((row) => {
          const participants = participantsByMatch.get(row.id) ?? [];
          return {
            id: row.id,
            server_id: row.serverId,
            server_name: row.serverName,
            server_slug: row.serverSlug,
            layer: row.layer,
            map: row.map,
            team1_faction: row.team1Faction,
            team2_faction: row.team2Faction,
            team1_tickets: row.team1Tickets,
            team2_tickets: row.team2Tickets,
            winner: row.winner,
            is_seed: row.isSeed,
            started_at: row.startedAt.toISOString(),
            ended_at: row.endedAt ? row.endedAt.toISOString() : null,
            duration_seconds: row.durationSeconds,
            clan_participants_count: participants.length,
            participants,
          };
        }),
        next_cursor: nextCursor,
        limit,
      };
    },
  );

  /**
   * Aggregates presence, primetime, and combat stats for a clan's current roster over
   * an inclusive [fromDay, toDay] window. Returns a zeroed payload when the roster is empty.
   */
  async function computeClanStats(
    clanId: string,
    fromDay: string,
    toDay: string,
  ): Promise<ClanStatsPayload> {
    const rosterRows = await app.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(eq(clanMembers.clanId, clanId));
    const roster = rosterRows.map((row) => row.playerId);

    if (roster.length === 0) {
      return emptyClanStatsPayload(clanId, fromDay, toDay);
    }

    const presenceRows = await app.db
      .select({
        day: playerDailyPresence.day,
        serverId: playerDailyPresence.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        online: sql<number>`COALESCE(SUM(${playerDailyPresence.onlineSeconds}), 0)::int`,
        boost: sql<number>`COALESCE(SUM(${playerDailyPresence.boostSeconds}), 0)::int`,
      })
      .from(playerDailyPresence)
      .leftJoin(servers, eq(servers.id, playerDailyPresence.serverId))
      .where(
        and(
          inArray(playerDailyPresence.playerId, roster),
          gte(playerDailyPresence.day, fromDay),
          lte(playerDailyPresence.day, toDay),
        ),
      )
      .groupBy(
        playerDailyPresence.day,
        playerDailyPresence.serverId,
        servers.displayName,
        servers.slug,
      )
      .orderBy(asc(playerDailyPresence.day));

    const chartByDay = new Map<string, { online: number; boost: number }>();
    for (let cursor = fromDay; cursor <= toDay; cursor = subtractDays(cursor, -1)) {
      chartByDay.set(cursor, { online: 0, boost: 0 });
    }
    const serverTotals = new Map<string, ClanStatsServerTotal>();
    let onlineTotal = 0;
    let boostTotal = 0;
    for (const row of presenceRows) {
      const dayEntry = chartByDay.get(row.day);
      if (dayEntry) {
        dayEntry.online += row.online;
        dayEntry.boost += row.boost;
      }
      onlineTotal += row.online;
      boostTotal += row.boost;

      const existingServer = serverTotals.get(row.serverId);
      if (existingServer) {
        existingServer.online_seconds += row.online;
      } else {
        serverTotals.set(row.serverId, {
          server_id: row.serverId,
          server_name: row.serverName,
          server_slug: row.serverSlug,
          online_seconds: row.online,
        });
      }
    }
    const chart: ClanStatsChartPoint[] = Array.from(chartByDay.entries()).map(([day, sums]) => ({
      day,
      online_seconds: sums.online,
      boost_seconds: sums.boost,
    }));
    const primaryServer =
      Array.from(serverTotals.values()).sort((a, b) => b.online_seconds - a.online_seconds)[0] ??
      null;

    const combatRows = await app.db
      .select({
        playerId: playerStatPeriods.playerId,
        canonicalName: players.canonicalName,
        kills: sql<number>`COALESCE(SUM(${playerStatPeriods.kills}), 0)::int`,
        deaths: sql<number>`COALESCE(SUM(${playerStatPeriods.deaths}), 0)::int`,
        revives: sql<number>`COALESCE(SUM(${playerStatPeriods.revives}), 0)::int`,
      })
      .from(playerStatPeriods)
      .innerJoin(players, eq(players.id, playerStatPeriods.playerId))
      .where(
        and(
          inArray(playerStatPeriods.playerId, roster),
          eq(playerStatPeriods.periodType, 'day'),
          isNull(playerStatPeriods.serverId),
          gte(playerStatPeriods.periodStart, fromDay),
          lte(playerStatPeriods.periodStart, toDay),
        ),
      )
      .groupBy(playerStatPeriods.playerId, players.canonicalName);

    let killsTotal = 0;
    let deathsTotal = 0;
    let revivesTotal = 0;
    const combatMembers: ClanStatsCombatMember[] = combatRows.map((row) => {
      killsTotal += row.kills;
      deathsTotal += row.deaths;
      revivesTotal += row.revives;
      return {
        player_id: row.playerId,
        canonical_name: row.canonicalName,
        kills: row.kills,
        deaths: row.deaths,
        revives: row.revives,
        kd: computeKdRatio(row.kills, row.deaths),
      };
    });
    combatMembers.sort((a, b) => b.kills - a.kills);
    const top = combatMembers.slice(0, STATS_TOP_MEMBERS_LIMIT);

    const windowStartMs = Date.parse(`${fromDay}T00:00:00.000Z`);
    const windowEndMs = Date.parse(`${toDay}T00:00:00.000Z`) + STATS_DAY_MS;
    const sessionRows = await app.db
      .select({
        connectedAt: playerSessions.connectedAt,
        disconnectedAt: playerSessions.disconnectedAt,
      })
      .from(playerSessions)
      .where(
        and(
          inArray(playerSessions.playerId, roster),
          lt(playerSessions.connectedAt, new Date(windowEndMs)),
          or(
            isNull(playerSessions.disconnectedAt),
            gt(playerSessions.disconnectedAt, new Date(windowStartMs)),
          ),
        ),
      )
      .orderBy(asc(playerSessions.connectedAt))
      .limit(STATS_SESSION_WINDOW_CAP);

    const histogram = bucketSessionsByLocalHour(
      sessionRows,
      0,
      windowStartMs,
      windowEndMs,
      windowEndMs,
    );
    const primetimeResult = computePrimetime(histogram);

    return {
      clan_id: clanId,
      from: fromDay,
      to: toDay,
      roster_size: roster.length,
      chart,
      totals: {
        online_seconds: onlineTotal,
        boost_seconds: boostTotal,
        primary_server: primaryServer,
      },
      primetime: {
        total_seconds: primetimeResult.totalSeconds,
        histogram: primetimeResult.histogram,
        rolling_average: primetimeResult.rollingAverage.map((value) => Math.round(value)),
        range: primetimeResult.range
          ? {
              label: primetimeResult.range.label,
              start_minutes: primetimeResult.range.startMinutes,
              end_minutes: primetimeResult.range.endMinutes,
              start_hour: primetimeResult.range.startHour,
              end_hour: primetimeResult.range.endHour,
            }
          : null,
      },
      combat: {
        kills: killsTotal,
        deaths: deathsTotal,
        revives: revivesTotal,
        kd: computeKdRatio(killsTotal, deathsTotal),
        top,
      },
    };
  }

  fast.get(
    '/api/v1/clans/:id/stats',
    { schema: { params: clanIdParams, querystring: statsQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const window = resolveStatsWindow(req.query.from, req.query.to);
      if (!window) {
        reply.code(400);
        return { error: 'invalid_range' };
      }
      return computeClanStats(clan.id, window.fromDay, window.toDay);
    },
  );

  fast.get(
    '/api/v1/clans/:id/stats/export',
    { schema: { params: clanIdParams, querystring: statsExportQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const window = resolveStatsWindow(req.query.from, req.query.to);
      if (!window) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(400);
        return { error: 'invalid_range' };
      }
      const stats = await computeClanStats(clan.id, window.fromDay, window.toDay);

      const lines = [
        'day,online_seconds,boost_seconds',
        ...stats.chart.map(
          (point) => `${point.day},${point.online_seconds},${point.boost_seconds}`,
        ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="clan-${clan.id}-stats-${stamp}.csv"`,
      );
      return body;
    },
  );

  fast.post(
    '/api/v1/clans',
    { schema: { body: createBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const id = uuidv7();
      try {
        await app.db.insert(clans).values({
          id,
          name: req.body.name,
          description: req.body.description ?? null,
          tags: req.body.tags ?? [],
          maxPrioritySlots: req.body.max_priority_slots ?? 10,
          primaryServerId: req.body.primary_server_id ?? null,
          isPublic: req.body.is_public ?? false,
          isTagProtected: req.body.is_tag_protected ?? false,
        });
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return {
            error: constraint === 'clans_name_active_key' ? 'clan_name_taken' : 'clan_tag_taken',
          };
        }
        if (code === '23503') {
          reply.code(400);
          return { error: 'invalid_primary_server' };
        }
        throw err;
      }
      const created = await loadActiveClan(id);
      if (!created) {
        reply.code(500);
        return { error: 'insert_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.create',
        targetType: 'clan',
        targetId: id,
        before: null,
        after: clanSnapshot(created),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      reply.code(201);
      return toClanDto(created);
    },
  );

  fast.patch(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams, body: updateBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const body = req.body;
      const touchesPrivilegedField =
        body.name !== undefined ||
        body.tags !== undefined ||
        body.max_priority_slots !== undefined ||
        body.primary_server_id !== undefined;
      if (!req.user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, req.user.playerId);
        if (role !== 'leader' && role !== 'deputy') {
          reply.code(403);
          return { error: 'forbidden' };
        }
        if (touchesPrivilegedField) {
          reply.code(403);
          return { error: 'forbidden' };
        }
      }
      const before = clanSnapshot(clan);
      const updates: Partial<typeof clans.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;
      if (body.max_priority_slots !== undefined) updates.maxPrioritySlots = body.max_priority_slots;
      if (body.primary_server_id !== undefined) updates.primaryServerId = body.primary_server_id;
      try {
        await app.db
          .update(clans)
          .set(updates)
          .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return {
            error: constraint === 'clans_name_active_key' ? 'clan_name_taken' : 'clan_tag_taken',
          };
        }
        if (code === '23514') {
          reply.code(409);
          return { error: 'priority_capacity_exceeded' };
        }
        if (code === '23503') {
          reply.code(400);
          return { error: 'invalid_primary_server' };
        }
        throw err;
      }
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/settings',
    { schema: { params: clanIdParams, body: settingsBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        const role = await membershipRole(clan.id, req.user.playerId);
        if (role !== 'leader' && role !== 'deputy') {
          reply.code(403);
          return { error: 'forbidden' };
        }
      }
      const before = clanSnapshot(clan);
      const updates: Partial<typeof clans.$inferInsert> = { updatedAt: new Date() };
      if (req.body.is_public !== undefined) updates.isPublic = req.body.is_public;
      if (req.body.is_tag_protected !== undefined)
        updates.isTagProtected = req.body.is_tag_protected;
      await app.db
        .update(clans)
        .set(updates)
        .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.settings.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.patch(
    '/api/v1/clans/:id/expire',
    { schema: { params: clanIdParams, body: expireBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const before = clanSnapshot(clan);
      const expiresAt = req.body.priority_expires_at
        ? new Date(req.body.priority_expires_at)
        : null;
      const now = new Date();
      // Extending/clearing the deadline resets the expirer's processed flag
      // so priorities re-materialize on the next sync without any manual
      // toggling — see clan-priority-expirer/src/tick.ts.
      const resetsExpiry = expiresAt === null || expiresAt > now;
      await app.db.transaction(async (tx) => {
        await tx
          .update(clans)
          .set({
            priorityExpiresAt: expiresAt,
            updatedAt: now,
            ...(resetsExpiry ? { priorityExpiryProcessed: false } : {}),
          })
          .where(and(eq(clans.id, clan.id), isNull(clans.deletedAt)));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'clan.expire.update',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: now.toISOString(),
          request_id: req.id,
        });
      });
      const updated = await loadActiveClan(clan.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.expire.update',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: clanSnapshot(updated),
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return toClanDto(updated);
    },
  );

  fast.delete(
    '/api/v1/clans/:id',
    { schema: { params: clanIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      if (!req.user.permissions.canManageClans) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const before = clanSnapshot(clan);
      const disbandedAt = new Date();
      await app.db.transaction(async (tx) => {
        await tx
          .update(clanMembers)
          .set({ hasPriority: false })
          .where(eq(clanMembers.clanId, clan.id));
        await tx
          .update(clans)
          .set({ deletedAt: disbandedAt, updatedAt: disbandedAt })
          .where(eq(clans.id, clan.id));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'clan.disband',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: disbandedAt.toISOString(),
          request_id: req.id,
        });
      });
      const afterRows = await app.db.select().from(clans).where(eq(clans.id, clan.id)).limit(1);
      const after = afterRows[0];
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.disband',
        targetType: 'clan',
        targetId: clan.id,
        before,
        after: after ? clanSnapshot(after) : null,
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, querystring: rosterQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const { q, sort, order, page, limit } = req.query;
      const offset = (page - 1) * limit;

      const filters = [sql`cm.clan_id = ${clan.id}`];
      if (q) {
        const nameMatch = normalizePlayerName(q);
        const exactMatch = q.toLowerCase();
        filters.push(
          sql`(p.canonical_name_normalized LIKE ${`%${nameMatch}%`} OR p.steam_id64::text = ${exactMatch} OR p.eos_id = ${exactMatch})`,
        );
      }
      const whereSql = and(...filters);

      const sortColumn = {
        name: sql`p.canonical_name`,
        role: sql`cm.member_role`,
        priority: sql`cm.has_priority`,
        joined_at: sql`cm.joined_at`,
        last_seen: sql`p.last_seen_at`,
        online: sql`online_60d`,
      }[sort];
      const direction = order === 'asc' ? sql`ASC` : sql`DESC`;

      const rows = (await app.db.execute(sql`
        SELECT cm.player_id, cm.member_role, cm.has_priority,
               cm.joined_at::text AS joined_at,
               p.canonical_name, p.steam_id64::text AS steam_id64, p.eos_id,
               p.last_seen_at::text AS last_seen_at,
               COALESCE(pres.online, 0)::int AS online_60d,
               EXISTS (
                 SELECT 1 FROM role_squad_permissions rsp
                 WHERE rsp.role_id = p.role_id AND rsp.squad_permission_key = ${RESERVE_SQUAD_PERMISSION_KEY}
               ) AS reserve_from_role
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        LEFT JOIN (
          SELECT player_id, SUM(online_seconds) AS online
          FROM player_daily_presence
          WHERE day >= (CURRENT_DATE - INTERVAL '60 days')
          GROUP BY player_id
        ) pres ON pres.player_id = cm.player_id
        WHERE ${whereSql}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, cm.joined_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as RosterRow[];

      const countRows = (await app.db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM clan_members cm
        JOIN players p ON p.id = cm.player_id
        WHERE ${whereSql}
      `)) as unknown as Array<{ total: number }>;
      const total = countRows[0]?.total ?? 0;

      const priorityCountRows = (await app.db.execute(sql`
        SELECT COUNT(*)::int AS priority_count
        FROM clan_members cm
        WHERE cm.clan_id = ${clan.id} AND cm.has_priority
      `)) as unknown as Array<{ priority_count: number }>;
      const priorityCount = priorityCountRows[0]?.priority_count ?? 0;

      return {
        clan_id: clan.id,
        priority_count: priorityCount,
        max_priority_slots: clan.maxPrioritySlots,
        items: rows.map((row) => ({
          player_id: row.player_id,
          canonical_name: row.canonical_name,
          steam_id64: row.steam_id64,
          eos_id: row.eos_id,
          member_role: row.member_role,
          has_priority: row.has_priority,
          reserve_from_role: row.reserve_from_role,
          joined_at: new Date(row.joined_at).toISOString(),
          last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
          online_60d_seconds: Number(row.online_60d),
        })),
        total,
        page,
        limit,
      };
    },
  );

  fast.get(
    '/api/v1/clans/:id/roster/export',
    { schema: { params: clanIdParams, querystring: rosterExportQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const rows = await app.db
        .select({
          canonicalName: players.canonicalName,
          steamId64: players.steamId64,
          memberRole: clanMembers.memberRole,
          hasPriority: clanMembers.hasPriority,
          joinedAt: clanMembers.joinedAt,
          lastSeenAt: players.lastSeenAt,
        })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(eq(clanMembers.clanId, clan.id))
        .orderBy(asc(clanMembers.joinedAt));

      const lines = [
        'canonical_name,steam_id64,member_role,has_priority,joined_at,last_seen_at',
        ...rows.map((row) =>
          [
            csvEscape(row.canonicalName),
            row.steamId64 ? row.steamId64.toString() : '',
            row.memberRole,
            row.hasPriority ? 'true' : 'false',
            row.joinedAt.toISOString(),
            row.lastSeenAt ? row.lastSeenAt.toISOString() : '',
          ].join(','),
        ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="clan-${clan.id}-roster-${stamp}.csv"`,
      );
      return body;
    },
  );

  fast.post(
    '/api/v1/clans/:id/members',
    { schema: { params: clanIdParams, body: addMemberBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, req.user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      if (level === 'deputy' && req.body.member_role !== 'member') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const [player] = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, req.body.player_id))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      try {
        await app.db.insert(clanMembers).values({
          clanId: clan.id,
          playerId: req.body.player_id,
          memberRole: req.body.member_role,
          hasPriority: false,
        });
      } catch (err) {
        const { code } = pgError(err);
        if (code === '23505') {
          reply.code(409);
          return { error: 'player_already_in_clan' };
        }
        throw err;
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.add',
        targetType: 'clan',
        targetId: clan.id,
        before: null,
        after: { player_id: req.body.player_id, member_role: req.body.member_role },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      reply.code(201);
      return {
        clan_id: clan.id,
        player_id: req.body.player_id,
        member_role: req.body.member_role,
      };
    },
  );

  fast.patch(
    '/api/v1/clans/:id/members/:playerId',
    { schema: { params: memberParams, body: setMemberRoleBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, req.user);
      if (level !== 'full') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const currentRole = await membershipRole(clan.id, req.params.playerId);
      if (!currentRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (currentRole === 'leader') {
        reply.code(409);
        return { error: 'cannot_demote_leader' };
      }
      if (currentRole !== req.body.member_role) {
        await app.db
          .update(clanMembers)
          .set({ memberRole: req.body.member_role })
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
          );
      }
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.role',
        targetType: 'clan',
        targetId: clan.id,
        before: { player_id: req.params.playerId, member_role: currentRole },
        after: { player_id: req.params.playerId, member_role: req.body.member_role },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return {
        clan_id: clan.id,
        player_id: req.params.playerId,
        member_role: req.body.member_role,
      };
    },
  );

  fast.delete(
    '/api/v1/clans/:id/members/:playerId',
    { schema: { params: memberParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, req.user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const currentRole = await membershipRole(clan.id, req.params.playerId);
      if (!currentRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (level === 'deputy' && currentRole !== 'member') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      if (currentRole === 'leader') {
        reply.code(409);
        return { error: 'sole_leader_removal' };
      }
      const [removedMember] = await app.db
        .select({ hasPriority: clanMembers.hasPriority })
        .from(clanMembers)
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)))
        .limit(1);
      const hadPriority = removedMember?.hasPriority ?? false;
      await app.db.transaction(async (tx) => {
        await tx
          .delete(clanMembers)
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
          );
        if (hadPriority) {
          await publishAdminsCfgSyncForAllServers(tx, app.redis, {
            reason: 'clan.member.remove',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
        }
      });
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.remove',
        targetType: 'clan',
        targetId: clan.id,
        before: { player_id: req.params.playerId, member_role: currentRole },
        after: null,
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return { ok: true };
    },
  );

  fast.put(
    '/api/v1/clans/:id/members/:playerId/priority',
    { schema: { params: memberParams, body: setPriorityBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, req.user);
      if (!level) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const [member] = await app.db
        .select({ hasPriority: clanMembers.hasPriority, roleId: players.roleId })
        .from(clanMembers)
        .innerJoin(players, eq(players.id, clanMembers.playerId))
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)))
        .limit(1);
      if (!member) {
        reply.code(404);
        return { error: 'member_not_found' };
      }

      const enabled = req.body.enabled;
      if (enabled === member.hasPriority) {
        const countRows = await app.db
          .select({ count: sql<number>`count(*)::int` })
          .from(clanMembers)
          .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
        return {
          player_id: req.params.playerId,
          has_priority: member.hasPriority,
          priority_count: Number(countRows[0]?.count ?? 0),
          max_priority_slots: clan.maxPrioritySlots,
        };
      }

      if (enabled) {
        const now = new Date();
        if (clan.priorityExpiresAt && clan.priorityExpiresAt <= now) {
          reply.code(409);
          return { error: 'priority_expired' };
        }
        if (member.roleId) {
          const [conflict] = await app.db
            .select({ roleId: roleSquadPermissions.roleId })
            .from(roleSquadPermissions)
            .where(
              and(
                eq(roleSquadPermissions.roleId, member.roleId),
                eq(roleSquadPermissions.squadPermissionKey, RESERVE_SQUAD_PERMISSION_KEY),
              ),
            )
            .limit(1);
          if (conflict) {
            reply.code(409);
            return { error: 'priority_source_conflict' };
          }
        }
      }

      let priorityCount = 0;
      try {
        await app.db.transaction(async (tx) => {
          if (enabled) {
            // Serialize concurrent toggles against the same clan so the
            // pool-limit check below can't race past max_priority_slots.
            await tx.execute(sql`SELECT id FROM clans WHERE id = ${clan.id} FOR UPDATE`);
            const countRows = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(clanMembers)
              .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
            const used = Number(countRows[0]?.count ?? 0);
            if (used + 1 > clan.maxPrioritySlots) {
              throw new PriorityPoolLimitError(used, clan.maxPrioritySlots);
            }
            priorityCount = used + 1;
          } else {
            const countRows = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(clanMembers)
              .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.hasPriority, true)));
            priorityCount = Math.max(0, Number(countRows[0]?.count ?? 0) - 1);
          }
          await tx
            .update(clanMembers)
            .set({ hasPriority: enabled })
            .where(
              and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.params.playerId)),
            );
          await publishAdminsCfgSyncForAllServers(tx, app.redis, {
            reason: 'clan.priority.toggle',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
        });
      } catch (err) {
        if (err instanceof PriorityPoolLimitError) {
          reply.code(409);
          return { error: 'priority_pool_limit', limit: err.limit, used: err.used };
        }
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.member.priority',
        targetType: 'clan',
        targetId: clan.id,
        before: { player_id: req.params.playerId, has_priority: member.hasPriority },
        after: { player_id: req.params.playerId, has_priority: enabled },
        context: { requestId: req.id, method: req.method, url: req.url },
      });

      return {
        player_id: req.params.playerId,
        has_priority: enabled,
        priority_count: priorityCount,
        max_priority_slots: clan.maxPrioritySlots,
      };
    },
  );

  fast.post(
    '/api/v1/clans/:id/transfer-leadership',
    { schema: { params: clanIdParams, body: transferBody }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const level = await clanManageLevel(clan.id, req.user);
      if (level !== 'full') {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const newLeaderRole = await membershipRole(clan.id, req.body.player_id);
      if (!newLeaderRole) {
        reply.code(404);
        return { error: 'member_not_found' };
      }
      if (newLeaderRole === 'leader') {
        reply.code(409);
        return { error: 'already_leader' };
      }
      const [currentLeader] = await app.db
        .select({ playerId: clanMembers.playerId })
        .from(clanMembers)
        .where(and(eq(clanMembers.clanId, clan.id), eq(clanMembers.memberRole, 'leader')))
        .limit(1);
      const previousLeaderId = currentLeader?.playerId ?? null;
      await app.db.transaction(async (tx) => {
        if (previousLeaderId) {
          await tx
            .update(clanMembers)
            .set({ memberRole: 'deputy' })
            .where(
              and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, previousLeaderId)),
            );
        }
        await tx
          .update(clanMembers)
          .set({ memberRole: 'leader' })
          .where(
            and(eq(clanMembers.clanId, clan.id), eq(clanMembers.playerId, req.body.player_id)),
          );
      });
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'clan.leadership.transfer',
        targetType: 'clan',
        targetId: clan.id,
        before: { leader_id: previousLeaderId },
        after: { leader_id: req.body.player_id },
        context: { requestId: req.id, method: req.method, url: req.url },
      });
      return {
        ok: true,
        clan_id: clan.id,
        leader_id: req.body.player_id,
        previous_leader_id: previousLeaderId,
      };
    },
  );
};

export default clansRoutes;
