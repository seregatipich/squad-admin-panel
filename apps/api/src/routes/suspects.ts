import {
  externalBans,
  markTypes,
  playerMarks,
  playerNameHistory,
  players,
  roles,
} from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

const SORT_VALUES = ['last_seen_desc', 'last_seen_asc'] as const;
type SortOption = (typeof SORT_VALUES)[number];

const listQuery = z.object({
  mark_type_ids: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  no_active_ban: z.enum(['true', 'false']).optional(),
  sort: z.enum(SORT_VALUES).default('last_seen_desc'),
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

interface MarkMini {
  mark_type_id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
}

interface RoleMini {
  id: string;
  name: string;
  color: string;
}

interface SuspectRow {
  id: string;
  steamId64: bigint | null;
  eosId: string | null;
  canonicalName: string;
  lastSeenAt: Date;
  roleId: string | null;
  roleName: string | null;
  roleColor: string | null;
}

interface SuspectDto {
  id: string;
  steam_id64: string | null;
  eos_id: string | null;
  canonical_name: string;
  last_seen_at: string;
  role: RoleMini | null;
  marks: MarkMini[];
  has_active_ban: boolean;
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
 * Parses the comma-separated `mark_type_ids` query param into a deduplicated
 * list of positive integers (OR-matched against a player's active marks).
 * Returns `null` when the param is absent, or `'invalid'` when any token is
 * not a positive integer.
 */
function parseMarkTypeIds(raw: string | undefined): number[] | null | 'invalid' {
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const ids: number[] = [];
  for (const token of tokens) {
    const n = Number(token);
    if (!Number.isInteger(n) || n <= 0) return 'invalid';
    ids.push(n);
  }
  return ids.length > 0 ? [...new Set(ids)] : null;
}

function encodeCursor(row: { lastSeenAt: Date; id: string }): string {
  return `${row.lastSeenAt.getTime()}_${row.id}`;
}

function parseCursor(raw: string): { lastSeenAt: Date; id: string } | null {
  const sep = raw.indexOf('_');
  if (sep === -1) return null;
  const millis = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(millis) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { lastSeenAt: new Date(millis), id };
}

const suspectsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /** True when a player currently has at least one uncleared mark (optionally restricted to `markTypeIds`). */
  function activeMarkExists(markTypeIds: number[] | null): SQL {
    const clauses = [eq(playerMarks.playerId, players.id), isNull(playerMarks.clearedAt)];
    if (markTypeIds) clauses.push(inArray(playerMarks.markTypeId, markTypeIds));
    return exists(
      app.db
        .select({ one: sql`1` })
        .from(playerMarks)
        .where(and(...clauses)),
    );
  }

  /** True when a player's steam_id64 or eos_id matches an unrevoked, unexpired external ban. */
  function activeBanExists(): SQL {
    const identityMatch = sql`(
      (${players.steamId64} IS NOT NULL AND ${externalBans.steamId64} = ${players.steamId64}::text)
      OR (${players.eosId} IS NOT NULL AND ${externalBans.eosId} = ${players.eosId})
    )`;
    return exists(
      app.db
        .select({ one: sql`1` })
        .from(externalBans)
        .where(
          and(
            isNull(externalBans.revokedAt),
            or(isNull(externalBans.expiresAt), gt(externalBans.expiresAt, sql`now()`)) as SQL,
            identityMatch,
          ),
        ),
    );
  }

  /** Matches `q` (normalized substring) against a player's current name or any historical name. */
  function nickMatches(q: string): SQL {
    const pattern = `%${normalizePlayerName(q)}%`;
    return or(
      sql`${players.canonicalNameNormalized} LIKE ${pattern}`,
      exists(
        app.db
          .select({ one: sql`1` })
          .from(playerNameHistory)
          .where(
            and(
              eq(playerNameHistory.playerId, players.id),
              sql`${playerNameHistory.nameNormalized} LIKE ${pattern}`,
            ),
          ),
      ),
    ) as SQL;
  }

  fast.get(
    '/api/v1/suspects',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const markTypeIds = parseMarkTypeIds(req.query.mark_type_ids);
      if (markTypeIds === 'invalid') {
        reply.code(400);
        return { error: 'invalid_mark_type_ids' };
      }

      const sort: SortOption = req.query.sort;
      const limit = req.query.limit ?? PAGE_SIZE_DEFAULT;
      const descending = sort !== 'last_seen_asc';
      const compare = descending ? lt : gt;

      const clauses: SQL[] = [activeMarkExists(markTypeIds)];
      if (req.query.q) clauses.push(nickMatches(req.query.q));
      if (req.query.no_active_ban === 'true') clauses.push(not(activeBanExists()));

      if (req.query.cursor) {
        const parsed = parseCursor(req.query.cursor);
        if (!parsed) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        clauses.push(
          or(
            compare(players.lastSeenAt, parsed.lastSeenAt),
            and(eq(players.lastSeenAt, parsed.lastSeenAt), compare(players.id, parsed.id)),
          ) as SQL,
        );
      }

      const orderCols = descending
        ? [desc(players.lastSeenAt), desc(players.id)]
        : [asc(players.lastSeenAt), asc(players.id)];

      const rows: SuspectRow[] = await app.db
        .select({
          id: players.id,
          steamId64: players.steamId64,
          eosId: players.eosId,
          canonicalName: players.canonicalName,
          lastSeenAt: players.lastSeenAt,
          roleId: roles.id,
          roleName: roles.name,
          roleColor: roles.color,
        })
        .from(players)
        .leftJoin(roles, eq(roles.id, players.roleId))
        .where(and(...clauses))
        .orderBy(...orderCols)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last) : null;

      const pageIds = page.map((r) => r.id);
      const marksByPlayer = new Map<string, MarkMini[]>();
      if (pageIds.length > 0) {
        const markRows = await app.db
          .select({
            playerId: playerMarks.playerId,
            markTypeId: markTypes.id,
            slug: markTypes.slug,
            labelEn: markTypes.labelEn,
            labelRu: markTypes.labelRu,
            icon: markTypes.icon,
            severity: markTypes.severity,
          })
          .from(playerMarks)
          .innerJoin(markTypes, eq(markTypes.id, playerMarks.markTypeId))
          .where(and(inArray(playerMarks.playerId, pageIds), isNull(playerMarks.clearedAt)))
          .orderBy(desc(markTypes.severity), asc(markTypes.sortOrder));
        for (const row of markRows) {
          const list = marksByPlayer.get(row.playerId) ?? [];
          list.push({
            mark_type_id: row.markTypeId,
            slug: row.slug,
            label_en: row.labelEn,
            label_ru: row.labelRu,
            icon: row.icon,
            severity: row.severity,
          });
          marksByPlayer.set(row.playerId, list);
        }
      }

      const bannedSteamIds = new Set<string>();
      const bannedEosIds = new Set<string>();
      const steamIds = page.map((r) => r.steamId64).filter((v): v is bigint => v !== null);
      const eosIds = page.map((r) => r.eosId).filter((v): v is string => v !== null);
      if (steamIds.length > 0 || eosIds.length > 0) {
        const banRows = await app.db
          .select({ steamId64: externalBans.steamId64, eosId: externalBans.eosId })
          .from(externalBans)
          .where(
            and(
              isNull(externalBans.revokedAt),
              or(isNull(externalBans.expiresAt), gt(externalBans.expiresAt, new Date())) as SQL,
              or(
                steamIds.length > 0
                  ? inArray(
                      externalBans.steamId64,
                      steamIds.map((id) => id.toString()),
                    )
                  : undefined,
                eosIds.length > 0 ? inArray(externalBans.eosId, eosIds) : undefined,
              ) as SQL,
            ),
          );
        for (const row of banRows) {
          if (row.steamId64) bannedSteamIds.add(row.steamId64);
          if (row.eosId) bannedEosIds.add(row.eosId);
        }
      }

      const items: SuspectDto[] = page.map((row) => ({
        id: row.id,
        steam_id64: row.steamId64 ? row.steamId64.toString() : null,
        eos_id: row.eosId,
        canonical_name: row.canonicalName,
        last_seen_at: row.lastSeenAt.toISOString(),
        role: row.roleId
          ? { id: row.roleId, name: row.roleName ?? '', color: row.roleColor ?? 'neutral' }
          : null,
        marks: marksByPlayer.get(row.id) ?? [],
        has_active_ban:
          (row.steamId64 !== null && bannedSteamIds.has(row.steamId64.toString())) ||
          (row.eosId !== null && bannedEosIds.has(row.eosId)),
      }));

      return { items, next_cursor: nextCursor };
    },
  );
};

export default suspectsRoutes;
