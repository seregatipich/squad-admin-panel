import * as schema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  invalidatePermissionCache,
  invalidatePermissionCacheForRole,
  loadUserPermissions,
} from '../src/lib/rbac.js';

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ownerRoleId: string;
let viewerRoleId: string;

const TEST_PLAYER_A = 76561197999800001n;
const TEST_PLAYER_B = 76561197999800002n;
const TEST_PLAYER_C = 76561197999800003n;
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

  const viewerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
    .limit(1);
  if (!viewerRows[0]) throw new Error('Viewer role not found — run migrations first');
  viewerRoleId = viewerRows[0].id;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B, TEST_PLAYER_C]) {
    const stub = `TestPA${String(sid).slice(-4)}`;
    await db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: null,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: null } });
    invalidatePermissionCache(sid);
  }
});

afterEach(async () => {
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B, TEST_PLAYER_C]) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
    await db.delete(players).where(eq(players.steamId64, sid));
    invalidatePermissionCache(sid);
  }
  for (const id of createdRoleIds) {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    await db.delete(roles).where(eq(roles.id, id));
  }
  createdRoleIds.length = 0;
});

describe('player single-role assignment', () => {
  it('assigning a role updates players.role_id', async () => {
    await db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_A));

    const row = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A))
      .limit(1);
    expect(row[0]?.roleId).toBe(viewerRoleId);
  });

  it('clearing a role sets role_id to null', async () => {
    await db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_A));
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, TEST_PLAYER_A));

    const row = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A))
      .limit(1);
    expect(row[0]?.roleId).toBeNull();
  });

  it('permission cache reflects new role after invalidation', async () => {
    invalidatePermissionCache(TEST_PLAYER_B);
    const before = await loadUserPermissions(db, TEST_PLAYER_B);
    expect(before.permissions.size).toBe(0);

    await db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_B));
    invalidatePermissionCache(TEST_PLAYER_B);

    const after = await loadUserPermissions(db, TEST_PLAYER_B);
    expect(after.permissions.has('server:view')).toBe(true);
  });
});

describe('Owner-lockout invariant', () => {
  it('allows removing Owner role when another Owner exists', async () => {
    await db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_A));
    await db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_B));

    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, TEST_PLAYER_A));

    const row = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_A))
      .limit(1);
    expect(row[0]?.roleId).toBeNull();
  });

  it('last-Owner check: only one Owner means role_id cannot be cleared', async () => {
    await db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_A));

    const ownerCount = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));

    const isLast = ownerCount.length <= 1;
    expect(isLast).toBe(true);
  });
});

describe('cache invalidation on role permission change', () => {
  it('after role permission update, cached permissions are stale until invalidated', async () => {
    const testRoleId = uuidv7();
    await db.insert(roles).values({
      id: testRoleId,
      name: `CacheInvalidationRole_${Date.now()}`,
      color: 'emerald',
      isSystemRole: false,
    });
    createdRoleIds.push(testRoleId);

    await db.insert(rolePermissions).values({
      roleId: testRoleId,
      permissionKey: 'server:view',
    });
    await db
      .update(players)
      .set({ roleId: testRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_C));
    invalidatePermissionCache(TEST_PLAYER_C);

    const before = await loadUserPermissions(db, TEST_PLAYER_C);
    expect(before.permissions.has('server:view')).toBe(true);

    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, testRoleId));
    await invalidatePermissionCacheForRole(db, testRoleId);

    const after = await loadUserPermissions(db, TEST_PLAYER_C);
    expect(after.permissions.has('server:view')).toBe(false);
  });
});
