import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/users', { config: { permissions: ['user:view'], audit: false } }, async () => {
    type UserRow = {
      steam_id64: string;
      canonical_name: string;
      last_seen_at: string;
      role_id: string;
      role_name: string;
      role_color: string;
      role_is_system: boolean;
      assigned_at: string | null;
      assigned_by: string | null;
    };
    const rows = await app.db.execute<UserRow>(sql`
        SELECT p.steam_id64::text AS steam_id64, p.canonical_name, p.last_seen_at,
               r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system,
               NULL::timestamptz AS assigned_at, NULL::text AS assigned_by
        FROM players p
        JOIN roles r ON r.id = p.role_id
        WHERE p.role_id IS NOT NULL
        ORDER BY p.last_seen_at DESC
      `);
    return (rows as unknown as UserRow[]).map((r) => ({
      steam_id64: r.steam_id64,
      canonical_name: r.canonical_name,
      last_seen_at: r.last_seen_at,
      role: {
        id: r.role_id,
        name: r.role_name,
        color: r.role_color,
        is_system_role: r.role_is_system,
      },
      assigned_at: r.assigned_at,
      assigned_by: r.assigned_by,
    }));
  });
};

export default usersRoutes;
