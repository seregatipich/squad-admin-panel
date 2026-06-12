import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const listQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  role_id: z.string().uuid().optional(),
});

const usersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/users',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['user:view'], audit: false },
    },
    async (req) => {
      type UserRow = {
        id: string;
        steam_id64: string | null;
        canonical_name: string;
        last_seen_at: string;
        role_id: string;
        role_name: string;
        role_color: string;
        role_is_system: boolean;
      };
      const q = req.query.q?.toLowerCase().trim();
      const roleId = req.query.role_id;
      const rows = await app.db.execute<UserRow>(sql`
        SELECT p.id, p.steam_id64::text AS steam_id64, p.canonical_name, p.last_seen_at,
               r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system
        FROM players p
        JOIN roles r ON r.id = p.role_id
        WHERE p.role_id IS NOT NULL
          ${roleId ? sql`AND r.id = ${roleId}` : sql``}
          ${
            q
              ? sql`AND (p.canonical_name_normalized LIKE ${`%${q}%`} OR p.steam_id64::text = ${q})`
              : sql``
          }
        ORDER BY p.last_seen_at DESC
      `);
      return (rows as unknown as UserRow[]).map((r) => ({
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
      }));
    },
  );
};

export default usersRoutes;
