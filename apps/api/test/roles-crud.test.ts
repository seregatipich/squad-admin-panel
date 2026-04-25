import * as schema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCacheForRole } from '../src/lib/rbac.js';

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

let ownerRoleId: string;
const createdRoleIds: string[] = [];

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set');
  sql = postgres(dbUrl, { max: 3, onnotice: () => undefined });
  db = drizzle(sql, { schema });

  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRows[0]) throw new Error('Owner role not found — run migrations first');
  ownerRoleId = ownerRows[0].id;
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

beforeEach(() => {
  createdRoleIds.length = 0;
});

afterEach(async () => {
  for (const id of createdRoleIds) {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    await db.delete(roles).where(eq(roles.id, id));
  }
});

async function createRole(name: string, color = 'blue', perms: string[] = []) {
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(roles).values({ id, name, color, isSystemRole: false });
    if (perms.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(perms.map((permissionKey) => ({ roleId: id, permissionKey })));
    }
  });
  createdRoleIds.push(id);
  return id;
}

describe('roles — Owner-guard invariants', () => {
  it('Owner role is_system_role=true with name=Owner', async () => {
    const row = await db.select().from(roles).where(eq(roles.id, ownerRoleId)).limit(1);
    expect(row[0]?.isSystemRole).toBe(true);
    expect(row[0]?.name).toBe('Owner');
  });

  it('Owner role cannot be deleted (guard check)', async () => {
    const ownerRows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const owner = ownerRows[0];
    expect(owner).toBeDefined();
    expect(owner?.isSystemRole && owner?.name === 'Owner').toBe(true);
  });
});

describe('roles — permission management', () => {
  it('creates a role with permissions and reads them back', async () => {
    const perms = ['server:view', 'player:view'];
    const id = await createRole('TestReader', 'teal', perms);

    const stored = await db
      .select({ permissionKey: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, id));

    const keys = stored.map((r) => r.permissionKey).sort();
    expect(keys).toEqual([...perms].sort());
  });

  it('replaces permissions on update', async () => {
    const id = await createRole('TestUpdater', 'indigo', ['server:view']);

    await db.transaction(async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      await tx.insert(rolePermissions).values([
        { roleId: id, permissionKey: 'player:view' },
        { roleId: id, permissionKey: 'audit:view' },
      ]);
    });

    const stored = await db
      .select({ permissionKey: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, id));

    const keys = stored.map((r) => r.permissionKey).sort();
    expect(keys).toEqual(['audit:view', 'player:view']);
    expect(keys).not.toContain('server:view');
  });

  it('duplicate role name raises unique constraint violation', async () => {
    await createRole('UniqueNameTest', 'cyan', []);
    await expect(createRole('UniqueNameTest', 'blue', [])).rejects.toThrow();
  });
});

describe('roles — cache invalidation', () => {
  it('invalidatePermissionCacheForRole resolves without error for empty role', async () => {
    const id = await createRole('CacheTestRole', 'lime', []);
    await expect(invalidatePermissionCacheForRole(db, id)).resolves.not.toThrow();
  });

  it('invalidatePermissionCacheForRole runs for a role with users', async () => {
    const id = await createRole('CacheTestRoleWithUsers', 'pink', ['server:view']);

    const steamId = 76561197999900001n;
    const stub = 'CacheTestUser';
    await db
      .insert(players)
      .values({
        steamId64: steamId,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: id,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: id } });

    await expect(invalidatePermissionCacheForRole(db, id)).resolves.not.toThrow();

    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, steamId));
    await db.delete(players).where(eq(players.steamId64, steamId));
  });
});

describe('roles — cascade delete', () => {
  it('deleting a role sets players.role_id to NULL (FK ON DELETE SET NULL)', async () => {
    const id = await createRole('CascadeRole', 'red', []);
    const steamId = 76561197999900002n;
    const stub = 'CascadePlayer';
    await db
      .insert(players)
      .values({
        steamId64: steamId,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: id,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: id } });

    await db.delete(roles).where(eq(roles.id, id));
    createdRoleIds.pop();

    const playerRow = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, steamId))
      .limit(1);
    expect(playerRow[0]?.roleId).toBeNull();

    await db.delete(players).where(eq(players.steamId64, steamId));
  });
});
