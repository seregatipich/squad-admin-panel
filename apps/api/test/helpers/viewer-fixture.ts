import type { DatabaseClient } from '@squad/db';
import { rolePermissions, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/**
 * Test fixture: a non-system "Viewer" role with a narrow read-only
 * permission set. The production seed (migration 0015) does NOT include
 * Viewer because the spec lists exactly Owner/Admin/Moderator/QueuePriority/
 * Cameraman/Intern as defaults. Tests that need a "narrow panel role"
 * fixture call this helper at beforeAll() time to recreate the legacy
 * Viewer row idempotently. Safe to call from multiple test files in any
 * order — keyed by name.
 */
export const VIEWER_PERMISSIONS = [
  'server:view',
  'config:view',
  'player:view',
  'audit:view',
  'host:view',
  'events:view',
  'role:view',
  'user:view',
  'admin_group:view',
  'whitelist:view',
  'backup:view',
  'trigger:view',
  'scheduler:view',
] as const;

export async function ensureViewerFixture(db: DatabaseClient): Promise<string> {
  const existing = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx
      .insert(roles)
      .values({
        id,
        name: 'Viewer',
        color: 'neutral',
        description: 'Test fixture — narrow read-only role.',
        isSystemRole: false,
        // Note: panel_access stays false; the role's panel reach is via
        // the explicit role_permissions rows below (legacy union path
        // in apps/api/src/lib/rbac.ts).
        panelAccess: false,
        canAssignRoles: false,
        canEditRoles: false,
      })
      .onConflictDoNothing();
    await tx
      .insert(rolePermissions)
      .values(VIEWER_PERMISSIONS.map((permissionKey) => ({ roleId: id, permissionKey })))
      .onConflictDoNothing();
  });
  return id;
}
