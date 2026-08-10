import * as schema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache, invalidatePermissionCacheForRole } from '../src/lib/rbac.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

let ownerRoleId: string;
const createdRoleIds: string[] = [];

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
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

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('roles — Owner-guard invariants', () => {
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

describeIfDb('roles — permission management', () => {
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

describeIfDb('roles — cache invalidation', () => {
  it('invalidatePermissionCacheForRole resolves without error for empty role', async () => {
    const id = await createRole('CacheTestRole', 'lime', []);
    await expect(invalidatePermissionCacheForRole(db, id)).resolves.not.toThrow();
  });

  it('invalidatePermissionCacheForRole runs for a role with users', async () => {
    const id = await createRole('CacheTestRoleWithUsers', 'pink', ['server:view']);

    const steamId = testSteamId(900001);
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

describeIfDb('roles — cascade delete', () => {
  it('deleting a role sets players.role_id to NULL (FK ON DELETE SET NULL)', async () => {
    const id = await createRole('CascadeRole', 'red', []);
    const steamId = testSteamId(900002);
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

describeIfDb('roles HTTP — description=null update and color validation', () => {
  const OWNER_STEAM = 76561198000001100n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    // ownerSteamId64 and ownerPlayerId are set together in buildIntegrationApp's
    // seedOwner branch, so ownerSteamId64 being truthy guarantees ownerPlayerId is too.
    if (h.seed.ownerSteamId64) invalidatePermissionCache(h.seed.ownerPlayerId as string);
    await h.cleanup();
  });

  it('PUT /roles/:id accepts description=null and clears the field', async () => {
    const cookie = await loginAsOwner(h);
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie },
      payload: { name: 'DescRole', color: 'blue', description: 'initial desc', permissions: [] },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };

    const update = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${id}`,
      headers: { cookie },
      payload: { description: null },
    });
    expect(update.statusCode).toBe(200);
    const body = update.json() as { description: string | null };
    expect(body.description).toBeNull();
  });

  it('POST /roles returns 400 for an invalid color value', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie },
      payload: { name: 'BadColor', color: 'not-a-real-color', permissions: [] },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('POST /roles returns 409 when role name already exists', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie },
      payload: { name: 'DupRole', color: 'green', permissions: [] },
    });
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie },
      payload: { name: 'DupRole', color: 'red', permissions: [] },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'role_name_taken' });
  });

  it('PUT /roles/:id returns 400 when trying to modify the Owner role', async () => {
    const cookie = await loginAsOwner(h);
    const all = await h.app.inject({ method: 'GET', url: '/api/v1/roles', headers: { cookie } });
    const ownerRole = (all.json() as Array<{ id: string; name: string }>).find(
      (r) => r.name === 'Owner',
    );
    expect(ownerRole).toBeDefined();
    if (!ownerRole) throw new Error('Owner role not found in GET /roles response');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${ownerRole.id}`,
      headers: { cookie },
      payload: { name: 'Hacker' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'owner_role_immutable' });
  });

  it('DELETE /roles/:id returns 400 when trying to delete the Owner role', async () => {
    const cookie = await loginAsOwner(h);
    const all = await h.app.inject({ method: 'GET', url: '/api/v1/roles', headers: { cookie } });
    const ownerRole = (all.json() as Array<{ id: string; name: string }>).find(
      (r) => r.name === 'Owner',
    );
    expect(ownerRole).toBeDefined();
    if (!ownerRole) throw new Error('Owner role not found in GET /roles response');
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${ownerRole.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'owner_role_immutable' });
  });

  it('GET /roles and GET /roles/:id return 401 without auth', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/roles' });
    expect(list.statusCode).toBe(401);

    const single = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles/019e0000-0000-7000-8000-000000000000',
    });
    expect(single.statusCode).toBe(401);
  });

  it('GET /roles/:id returns 404 for unknown id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles/019e0000-0000-7000-8000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
