import { normalizePlayerName } from '@squad/shared-config';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { encodeLastSeenCursor, parseLastSeenCursor } from '../lib/last-seen-cursor.js';
import { steamId64Equals } from '../lib/player-search.js';
import { containsPattern } from '../lib/sql-like.js';

const PAGE_SIZE_DEFAULT = 200;
const PAGE_SIZE_MAX = 500;

const listQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  role_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  cursor: z.string().max(80).optional(),
});

/** Response header carrying the keyset cursor of the next page; absent on the last page. */
const NEXT_CURSOR_HEADER = 'x-next-cursor';

const usersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/users',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req, reply) => {
      type UserRow = {
        id: string;
        steam_id64: string | null;
        canonical_name: string;
        last_seen_at: string;
        role_id: string;
        role_name: string;
        role_color: string;
        role_is_system: boolean;
        role_expires_at: string | null;
        role_comment: string | null;
        discord_linked: boolean;
        last_seen_micros: string;
      };
      const q = req.query.q?.toLowerCase().trim();
      // canonical_name_normalized is populated by normalizePlayerName (strips
      // clan tags / leading non-letters, collapses whitespace); matching the
      // raw lower-cased query against it misses names like "[RU] Vasya", the
      // way suspects.ts already normalizes its own nickname search (finding
      // #358). The LIKE pattern is also escaped so a literal `%`/`_`/`\` in
      // the query — `_` in particular is common in Squad clan tags — isn't
      // treated as a wildcard.
      const namePattern = q ? containsPattern(normalizePlayerName(q)) : undefined;
      const roleId = req.query.role_id;
      const { limit } = req.query;
      const cursor = req.query.cursor ? parseLastSeenCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) {
        reply.code(400);
        return { error: 'invalid_cursor' };
      }
      const rows = await app.db.execute<UserRow>(sql`
        SELECT p.id, p.steam_id64::text AS steam_id64, p.canonical_name, p.last_seen_at,
               r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system,
               p.role_expires_at::text AS role_expires_at,
               p.role_comment AS role_comment,
               (pdl.player_id IS NOT NULL) AS discord_linked,
               (extract(epoch from p.last_seen_at) * 1000000)::bigint::text AS last_seen_micros
        FROM players p
        JOIN roles r ON r.id = p.role_id
        LEFT JOIN player_discord_links pdl ON pdl.player_id = p.id
        WHERE p.role_id IS NOT NULL
          ${roleId ? sql`AND r.id = ${roleId}` : sql``}
          ${
            q && namePattern
              ? sql`AND (p.canonical_name_normalized LIKE ${namePattern} OR ${steamId64Equals(sql`p.steam_id64`, q)})`
              : sql``
          }
          ${
            cursor
              ? sql`AND (p.last_seen_at, p.id) < ((timestamptz 'epoch' + ${cursor.lastSeenMicros}::bigint * interval '1 microsecond'), ${cursor.id}::uuid)`
              : sql``
          }
        ORDER BY p.last_seen_at DESC, p.id DESC
        LIMIT ${limit + 1}
      `);
      const fetched = rows as unknown as UserRow[];
      const page = fetched.slice(0, limit);
      const last = page.at(-1);
      if (fetched.length > limit && last) {
        void reply.header(
          NEXT_CURSOR_HEADER,
          encodeLastSeenCursor({ lastSeenMicros: last.last_seen_micros, id: last.id }),
        );
      }
      return page.map((r) => ({
        id: r.id,
        steam_id64: r.steam_id64,
        canonical_name: r.canonical_name,
        last_seen_at: r.last_seen_at,
        role: {
          id: r.role_id,
          name: r.role_name,
          color: r.role_color,
          is_system_role: r.role_is_system,
        },
        assigned_at: null,
        assigned_by: null,
        role_expires_at: r.role_expires_at ? new Date(r.role_expires_at).toISOString() : null,
        role_comment: r.role_comment,
        // DISCORD-4 (#151): a boolean only — the raw `discord_user_id` is
        // served exclusively by GET /api/v1/players/:playerId/discord.
        discord_linked: r.discord_linked === true,
      }));
    },
  );
};

export default usersRoutes;
