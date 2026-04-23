import {
  type RoleName,
  SYSTEM_ROLE_CLEARANCE,
  SYSTEM_ROLE_PERMISSIONS,
} from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { DatabaseClient } from '../client.js';
import { rolePermissions, roles } from '../schema/index.js';

export interface SeededRole {
  id: string;
  name: RoleName;
}

export async function seedSystemRoles(db: DatabaseClient, orgId: string): Promise<SeededRole[]> {
  const seeded: SeededRole[] = [];
  const names: RoleName[] = ['Owner', 'Senior Admin', 'Admin', 'Viewer'];

  for (const name of names) {
    const id = uuidv7();
    await db
      .insert(roles)
      .values({
        id,
        orgId,
        name,
        clearanceLevel: SYSTEM_ROLE_CLEARANCE[name],
        isSystemRole: true,
        description: `Built-in ${name} role`,
      })
      .onConflictDoNothing();

    const existing = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .limit(1000);
    const actualId = existing.find((r) => r.id === id)?.id ?? id;

    await db
      .insert(rolePermissions)
      .values(
        SYSTEM_ROLE_PERMISSIONS[name].map((key) => ({
          roleId: actualId,
          permissionKey: key,
        })),
      )
      .onConflictDoNothing();

    seeded.push({ id: actualId, name });
  }

  return seeded;
}
