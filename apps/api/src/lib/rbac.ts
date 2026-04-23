import type { DatabaseClient } from '@squad/db';
import { rolePermissions, roles, servers, userRoleAssignments } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import { and, eq, inArray } from 'drizzle-orm';

export interface PermissionContext {
  permissions: Set<PermissionKey>;
  clearance: number;
  roleIds: string[];
}

const cache = new Map<string, { value: PermissionContext; expiresAt: number }>();
const TTL_MS = 30_000;

export async function loadUserPermissions(
  db: DatabaseClient,
  userId: string,
): Promise<PermissionContext> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const userRoles = await db
    .select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, userId));
  const roleIds = userRoles.map((r) => r.roleId);

  if (roleIds.length === 0) {
    const empty: PermissionContext = { permissions: new Set(), clearance: 0, roleIds: [] };
    cache.set(userId, { value: empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  const perms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, roleIds));

  const roleRows = await db
    .select({ clearance: roles.clearanceLevel })
    .from(roles)
    .where(inArray(roles.id, roleIds));

  const clearance = roleRows.reduce((max, r) => Math.max(max, r.clearance), 0);
  const permissions = new Set(perms.map((p) => p.key as PermissionKey));
  const value: PermissionContext = { permissions, clearance, roleIds };
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidatePermissionCache(userId: string): void {
  cache.delete(userId);
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) {
    if (!ctx.permissions.has(key)) return false;
  }
  return true;
}

/**
 * Verify the user has the required permissions scoped to a specific server.
 * Phase 0 uses org-wide permissions only; future phases will consult
 * role_server_scopes. The signature is kept stable so upgrading does not
 * require route touch-ups.
 */
export async function hasServerPermission(
  db: DatabaseClient,
  ctx: PermissionContext,
  serverId: string,
  required: readonly PermissionKey[],
): Promise<boolean> {
  if (!hasPermission(ctx, required)) return false;
  const row = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId)))
    .limit(1);
  return row.length > 0;
}
