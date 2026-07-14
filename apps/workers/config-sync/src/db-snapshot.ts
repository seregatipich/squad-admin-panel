import type { DatabaseClient } from '@squad/db';
import { sql } from 'drizzle-orm';
import type { AdminEntry, ClanPriorityEntry, RoleEntry } from './segment.js';

interface RoleSqlRow extends Record<string, unknown> {
  name: string;
  squad_permissions: string[];
}

interface AdminSqlRow extends Record<string, unknown> {
  eos_id: string;
  role_name: string;
}

interface ClanPrioritySqlRow extends Record<string, unknown> {
  eos_id: string;
  clan_name: string;
}

export async function snapshotRolesAndAdmins(db: DatabaseClient): Promise<{
  roles: RoleEntry[];
  admins: AdminEntry[];
  clanPriority: ClanPriorityEntry[];
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
    SELECT p.eos_id, r.name AS role_name
    FROM players p
    JOIN roles r ON r.id = p.role_id
    WHERE p.role_id IS NOT NULL AND p.eos_id IS NOT NULL
    ORDER BY r.name, p.eos_id
  `);
  // CLAN-4: members with an active, unexpired clan priority slot — excludes
  // members whose role already grants `reserve` (no duplicate Admin= line
  // for the same eos_id) and members without an eos_id (nothing to write).
  const clanPriorityRows = await db.execute<ClanPrioritySqlRow>(sql`
    SELECT p.eos_id, c.name AS clan_name
    FROM clan_members cm
    JOIN clans c ON c.id = cm.clan_id AND c.deleted_at IS NULL
    JOIN players p ON p.id = cm.player_id AND p.eos_id IS NOT NULL
    WHERE cm.has_priority
      AND (c.priority_expires_at IS NULL OR c.priority_expires_at > now())
      AND NOT EXISTS (
        SELECT 1 FROM role_squad_permissions rsp
        WHERE rsp.role_id = p.role_id AND rsp.squad_permission_key = 'reserve'
      )
    ORDER BY c.name, p.eos_id
  `);
  return {
    roles: (roleRows as unknown as RoleSqlRow[]).map((r) => ({
      name: r.name,
      squadPermissions: r.squad_permissions ?? [],
    })),
    admins: (adminRows as unknown as AdminSqlRow[]).map((a) => ({
      eosId: a.eos_id,
      roleName: a.role_name,
    })),
    clanPriority: (clanPriorityRows as unknown as ClanPrioritySqlRow[]).map((c) => ({
      eosId: c.eos_id,
      clanName: c.clan_name,
    })),
  };
}
