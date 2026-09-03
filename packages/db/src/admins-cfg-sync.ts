import type { AdminEntry, ClanPriorityEntry, RoleEntry } from '@squad/shared-config/admins-config';
import { buildManagedSegmentBody, spliceManagedSegment } from '@squad/shared-config/admins-config';
import { sql } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';

const ADMINS_CFG_MARKERS = ['//SQUAD-PANEL BEGIN', '//SQUAD-PANEL END'] as const;

/** Remove every managed block plus any authority line outside a complete block. */
export function stripAdminsCfgManagedAuthority(content: string): string {
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const body = lines[index]?.replace(/[\r\n]+$/, '') ?? '';
    if (body.includes(ADMINS_CFG_MARKERS[0])) {
      let completeEnd = -1;
      for (let candidate = index; candidate < lines.length; candidate += 1) {
        if (lines[candidate]?.includes(ADMINS_CFG_MARKERS[1])) {
          completeEnd = candidate;
          break;
        }
      }
      if (completeEnd >= index) index = completeEnd;
      continue;
    }
    if (body.includes(ADMINS_CFG_MARKERS[1]) || /^\s*(?:Admin|Group)\s*=/i.test(body)) {
      continue;
    }
    kept.push(lines[index] ?? '');
  }
  return kept.join('');
}

export type AdminsCfgSyncTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RoleSqlRow extends Record<string, unknown> {
  name: string;
  squad_permissions: string[];
}

interface AdminSqlRow extends Record<string, unknown> {
  eos_id: string;
  role_name: string;
  comment: string | null;
}

interface ClanPrioritySqlRow extends Record<string, unknown> {
  eos_id: string;
  clan_name: string;
}

interface VipLifecycleStrictSqlRow extends Record<string, unknown> {
  strict: boolean;
}

export async function isVipLifecycleStrict(
  db: Pick<AdminsCfgSyncTransaction, 'execute'>,
): Promise<boolean> {
  const rows = (await db.execute<VipLifecycleStrictSqlRow>(sql`
    SELECT vip_lifecycle_strict AS strict
      FROM panel_meta
     WHERE id = 1
       FOR SHARE
  `)) as unknown as VipLifecycleStrictSqlRow[];
  return rows[0]?.strict === true;
}

/** Serialize every Panel Admins.cfg writer for one server across processes. */
export async function withAdminsCfgServerLock<T>(
  db: Pick<DatabaseClient, 'transaction'>,
  serverId: string,
  work: (tx: AdminsCfgSyncTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('admins-cfg-sync:' || ${serverId}, 0))`,
    );
    return work(tx);
  });
}

/** Read the exact database projection used to regenerate the managed segment. */
export async function snapshotRolesAndAdmins(
  db: Pick<AdminsCfgSyncTransaction, 'execute'>,
): Promise<{
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
    SELECT p.eos_id, r.name AS role_name, p.role_comment AS comment
    FROM players p
    JOIN roles r ON r.id = p.role_id
    WHERE p.role_id IS NOT NULL AND p.eos_id IS NOT NULL
    ORDER BY r.name, p.eos_id
  `);
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
    roles: (roleRows as unknown as RoleSqlRow[]).map((row) => ({
      name: row.name,
      squadPermissions: row.squad_permissions ?? [],
    })),
    admins: (adminRows as unknown as AdminSqlRow[]).map((row) => ({
      eosId: row.eos_id,
      roleName: row.role_name,
      comment: row.comment ?? null,
    })),
    clanPriority: (clanPriorityRows as unknown as ClanPrioritySqlRow[]).map((row) => ({
      eosId: row.eos_id,
      clanName: row.clan_name,
    })),
  };
}

/**
 * After the durable VIP cutover, the database is the only source for the
 * managed Admins.cfg segment. Editors and restores may still supply the
 * surrounding unmanaged bytes, but never replay an older managed projection.
 */
export async function protectAdminsCfgManagedSegment(
  db: AdminsCfgSyncTransaction,
  proposedContent: string,
): Promise<string> {
  if (!(await isVipLifecycleStrict(db))) return proposedContent;

  const snapshot = await snapshotRolesAndAdmins(db);
  const unmanagedContent = stripAdminsCfgManagedAuthority(proposedContent);
  return spliceManagedSegment(unmanagedContent, buildManagedSegmentBody(snapshot).body);
}
