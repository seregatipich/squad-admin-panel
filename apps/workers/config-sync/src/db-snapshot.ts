import type { DatabaseClient } from '@squad/db';
import { sql } from 'drizzle-orm';
import type { AdminEntry, RoleEntry } from './segment.js';

interface RoleSqlRow extends Record<string, unknown> {
  name: string;
  squad_permissions: string[];
}

interface AdminSqlRow extends Record<string, unknown> {
  steam_id64: string;
  role_name: string;
}

export async function snapshotRolesAndAdmins(db: DatabaseClient): Promise<{
  roles: RoleEntry[];
  admins: AdminEntry[];
}> {
  const roleRows = await db.execute<RoleSqlRow>(sql`
    SELECT r.name,
      COALESCE(
        (SELECT array_agg(rsp.squad_permission_key ORDER BY rsp.squad_permission_key)
         FROM role_squad_permissions rsp WHERE rsp.role_id = r.id),
        ARRAY[]::text[]
      ) AS squad_permissions
    FROM roles r
    ORDER BY r.name
  `);
  const adminRows = await db.execute<AdminSqlRow>(sql`
    SELECT p.steam_id64::text AS steam_id64, r.name AS role_name
    FROM players p
    JOIN roles r ON r.id = p.role_id
    WHERE p.role_id IS NOT NULL
    ORDER BY r.name, p.steam_id64
  `);
  return {
    roles: (roleRows as unknown as RoleSqlRow[]).map((r) => ({
      name: r.name,
      squadPermissions: r.squad_permissions ?? [],
    })),
    admins: (adminRows as unknown as AdminSqlRow[]).map((a) => ({
      steamId64: a.steam_id64,
      roleName: a.role_name,
    })),
  };
}
