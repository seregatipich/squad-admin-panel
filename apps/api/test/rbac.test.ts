import * as schema from '@squad/db/schema';
import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  invalidatePermissionCache,
  invalidatePermissionCacheForRole,
  loadUserPermissions,
} from '../src/lib/rbac.js';
import { testSteamId } from './helpers/snapshot-restore.js';

const PLAYER_A = testSteamId(1);
const PLAYER_B = testSteamId(2);
const PLAYER_C = testSteamId(3);

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

let viewerRoleId: string;

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;

  sql = postgres(dbUrl, { max: 3, onnotice: () => undefined });
  db = drizzle(sql, { schema });

  // Migration 0015 dropped the legacy Viewer role; re-create it as a
  // test fixture for tests that exercise narrow read-only permissions.
  const { ensureViewerFixture } = await import('./helpers/viewer-fixture.js');
  await ensureViewerFixture(db as unknown as Parameters<typeof ensureViewerFixture>[0]);

  const viewerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
    .limit(1);

  const viewerId = viewerRows[0]?.id;
  if (!viewerId) throw new Error('Viewer system role not found — run migrations first');
  viewerRoleId = viewerId;

  for (const [steamId64, roleId] of [
    [PLAYER_A, null],
    [PLAYER_B, viewerRoleId],
    [PLAYER_C, viewerRoleId],
  ] as const) {
    const stub = `Test ${String(steamId64).slice(-4)}`;
    await db
      .insert(players)
      .values({
        steamId64,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: roleId ?? null,
      })
      .onConflictDoUpdate({
        target: players.steamId64,
        set: { roleId: roleId ?? null },
      });
  }
});

afterAll(async () => {
  for (const sid of [PLAYER_A, PLAYER_B, PLAYER_C]) {
    await db.delete(players).where(eq(players.steamId64, sid));
    invalidatePermissionCache(sid);
  }
  if (sql) await sql.end({ timeout: 5 });
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('loadUserPermissions', () => {
  it('returns empty set + roleId=null for a player with no role', async () => {
    invalidatePermissionCache(PLAYER_A);
    const ctx = await loadUserPermissions(db, PLAYER_A);
    expect(ctx.permissions.size).toBe(0);
    expect(ctx.roleId).toBeNull();
  });

  it('returns Viewer permissions for a Viewer-roled player', async () => {
    invalidatePermissionCache(PLAYER_B);
    const ctx = await loadUserPermissions(db, PLAYER_B);
    expect(ctx.roleId).toBe(viewerRoleId);
    expect(ctx.permissions.has('server:view')).toBe(true);
    expect(ctx.permissions.has('player:view')).toBe(true);
    expect(ctx.permissions.has('server:start')).toBe(false);
  });

  it('caches result on second call (same object identity)', async () => {
    invalidatePermissionCache(PLAYER_B);
    const a = await loadUserPermissions(db, PLAYER_B);
    const b = await loadUserPermissions(db, PLAYER_B);
    expect(b).toBe(a);
  });
});

describeIfDb('invalidatePermissionCache', () => {
  it('forces re-fetch on next call', async () => {
    const before = await loadUserPermissions(db, PLAYER_B);
    invalidatePermissionCache(PLAYER_B);
    const after = await loadUserPermissions(db, PLAYER_B);
    expect(after).not.toBe(before);
    expect([...after.permissions]).toEqual([...before.permissions]);
  });
});

describeIfDb('invalidatePermissionCacheForRole', () => {
  it('invalidates all carriers of a role', async () => {
    const beforeB = await loadUserPermissions(db, PLAYER_B);
    const beforeC = await loadUserPermissions(db, PLAYER_C);

    await invalidatePermissionCacheForRole(db, viewerRoleId);

    const afterB = await loadUserPermissions(db, PLAYER_B);
    const afterC = await loadUserPermissions(db, PLAYER_C);
    expect(afterB).not.toBe(beforeB);
    expect(afterC).not.toBe(beforeC);
  });

  it('does not affect users not carrying the role', async () => {
    invalidatePermissionCache(PLAYER_A);
    const beforeA = await loadUserPermissions(db, PLAYER_A);
    await invalidatePermissionCacheForRole(db, viewerRoleId);
    const afterA = await loadUserPermissions(db, PLAYER_A);
    expect(afterA).toBe(beforeA);
  });
});
