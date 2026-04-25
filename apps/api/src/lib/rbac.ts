import type { DatabaseClient } from '@squad/db';
import { playerRoleAssignments, rolePermissions, roles, servers } from '@squad/db/schema';
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
  steamId64: bigint,
): Promise<PermissionContext> {
  const cacheKey = String(steamId64);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const playerRoles = await db
    .select({ roleId: playerRoleAssignments.roleId })
    .from(playerRoleAssignments)
    .where(eq(playerRoleAssignments.steamId64, steamId64));
  const roleIds = playerRoles.map((r) => r.roleId);

  if (roleIds.length === 0) {
    const empty: PermissionContext = { permissions: new Set(), clearance: 0, roleIds: [] };
    cache.set(cacheKey, { value: empty, expiresAt: Date.now() + TTL_MS });
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
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidatePermissionCache(steamId64: bigint): void {
  cache.delete(String(steamId64));
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) {
    if (!ctx.permissions.has(key)) return false;
  }
  return true;
}

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
