import type { DatabaseClient } from '@squad/db';
import { players, rolePermissions } from '@squad/db/schema';
import {
  isPermissionKey,
  PERMISSION_KEYS,
  type PermissionKey,
  SQUAD_PERMISSION_KEYS,
  type SquadPermissionKey,
} from '@squad/shared-config';
import { eq, sql } from 'drizzle-orm';

export interface PermissionContext {
  permissions: Set<PermissionKey>;
  squadPermissions: Set<SquadPermissionKey>;
  roleId: string | null;
  roleName: string | null;
  panelAccess: boolean;
  canAssignRoles: boolean;
  canEditRoles: boolean;
  canManageBanSources: boolean;
  isOwner: boolean;
}

const cache = new Map<string, { value: PermissionContext; expiresAt: number }>();
const TTL_MS = 30_000;

const PANEL_PERMS_GATED_BY_ASSIGN: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'user:manage_roles',
]);
const PANEL_PERMS_GATED_BY_EDIT: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'role:create',
  'role:edit',
  'role:delete',
]);
const ALL_PANEL_PERMS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(PERMISSION_KEYS);

function derivePanelPermissions(
  panelAccess: boolean,
  canAssignRoles: boolean,
  canEditRoles: boolean,
  isOwner: boolean,
): Set<PermissionKey> {
  if (isOwner) return new Set(ALL_PANEL_PERMS);
  if (!panelAccess) return new Set();
  const out = new Set<PermissionKey>();
  for (const key of ALL_PANEL_PERMS) {
    if (PANEL_PERMS_GATED_BY_ASSIGN.has(key) && !canAssignRoles) continue;
    if (PANEL_PERMS_GATED_BY_EDIT.has(key) && !canEditRoles) continue;
    out.add(key);
  }
  return out;
}

interface RoleContextRow extends Record<string, unknown> {
  role_id: string | null;
  role_name: string | null;
  is_system_role: boolean | null;
  panel_access: boolean | null;
  can_assign_roles: boolean | null;
  can_edit_roles: boolean | null;
  can_manage_ban_sources: boolean | null;
  squad_permissions: string[] | null;
}

export async function loadUserPermissions(
  db: DatabaseClient,
  playerId: string,
): Promise<PermissionContext> {
  const hit = cache.get(playerId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const rows = await db.execute<RoleContextRow>(sql`
    SELECT
      r.id   AS role_id,
      r.name AS role_name,
      r.is_system_role,
      r.panel_access,
      r.can_assign_roles,
      r.can_edit_roles,
      r.can_manage_ban_sources,
      COALESCE(
        (SELECT array_agg(rsp.squad_permission_key ORDER BY rsp.squad_permission_key)
         FROM role_squad_permissions rsp WHERE rsp.role_id = r.id),
        ARRAY[]::text[]
      ) AS squad_permissions
    FROM players p
    LEFT JOIN roles r ON r.id = p.role_id
    WHERE p.id = ${playerId}
    LIMIT 1
  `);
  const row = (rows as unknown as RoleContextRow[])[0];

  if (!row || !row.role_id) {
    const empty: PermissionContext = {
      permissions: new Set(),
      squadPermissions: new Set(),
      roleId: null,
      roleName: null,
      panelAccess: false,
      canAssignRoles: false,
      canEditRoles: false,
      canManageBanSources: false,
      isOwner: false,
    };
    cache.set(playerId, { value: empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  const isOwner = row.role_name === 'Owner' && row.is_system_role === true;
  const panelAccess = isOwner ? true : (row.panel_access ?? false);
  const canAssignRoles = isOwner ? true : (row.can_assign_roles ?? false);
  const canEditRoles = isOwner ? true : (row.can_edit_roles ?? false);
  const canManageBanSources = isOwner ? true : panelAccess && (row.can_manage_ban_sources ?? false);
  const squadPermissions = isOwner
    ? new Set<SquadPermissionKey>(SQUAD_PERMISSION_KEYS)
    : new Set<SquadPermissionKey>(
        ((row.squad_permissions ?? []) as SquadPermissionKey[]).filter(Boolean),
      );

  const explicit = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, row.role_id));

  const permissions = derivePanelPermissions(panelAccess, canAssignRoles, canEditRoles, isOwner);
  for (const entry of explicit) {
    if (isPermissionKey(entry.key)) permissions.add(entry.key);
  }

  const value: PermissionContext = {
    permissions,
    squadPermissions,
    roleId: row.role_id,
    roleName: row.role_name,
    panelAccess,
    canAssignRoles,
    canEditRoles,
    canManageBanSources,
    isOwner,
  };
  cache.set(playerId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidatePermissionCache(playerId: string): void {
  cache.delete(playerId);
}

export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void> {
  const rows = await db.select({ id: players.id }).from(players).where(eq(players.roleId, roleId));
  for (const r of rows) cache.delete(r.id);
}

export function invalidateAllPermissionCaches(): void {
  cache.clear();
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) if (!ctx.permissions.has(key)) return false;
  return true;
}
