import type { DatabaseClient } from '@squad/db';
import { players, rolePermissions } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import { eq } from 'drizzle-orm';

export interface PermissionContext {
  permissions: Set<PermissionKey>;
  roleId: string | null;
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

  const playerRows = await db
    .select({ roleId: players.roleId })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  const roleId = playerRows[0]?.roleId ?? null;

  if (!roleId) {
    const empty: PermissionContext = { permissions: new Set(), roleId: null };
    cache.set(cacheKey, { value: empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  const perms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  const permissions = new Set(perms.map((p) => p.key as PermissionKey));
  const value: PermissionContext = { permissions, roleId };
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidatePermissionCache(steamId64: bigint): void {
  cache.delete(String(steamId64));
}

export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void> {
  const rows = await db
    .select({ steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.roleId, roleId));
  for (const r of rows) cache.delete(String(r.steamId64));
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) if (!ctx.permissions.has(key)) return false;
  return true;
}
