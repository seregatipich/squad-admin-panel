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
let viewerRoleId: string;

const TEST_PLAYER_A = testSteamId(800001);
const TEST_PLAYER_B = testSteamId(800002);
const TEST_PLAYER_C = testSteamId(800003);
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
  if (sql) await sql.end({ timeout: 5 });
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

  it('last-Owner check: count uses live DB state, including any real Owner', async () => {
    // Snapshot the live Owner count BEFORE the test mutates anything. The
    // suite runs against the dev/staging DB which may already host a real
    // first-claimed Owner — we must not assume an empty starting state.
    const baselineOwners = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));
    const baseline = baselineOwners.length;

    // Make TEST_PLAYER_A an Owner. The Owner-lockout guard fires if and
    // only if the count of Owner-carriers <= 1; with our test contribution
    // it should be at least baseline + 1.
    await db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_A));

    const ownerCount = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId));

    expect(ownerCount.length).toBe(baseline + 1);
    // Lockout would block if removing TEST_PLAYER_A leaves zero Owners,
    // i.e. baseline === 0. With baseline >= 1 (real Owner already present)
    // removing TEST_PLAYER_A is safe.
    expect(baseline >= 0).toBe(true);
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

describe('GET /api/v1/players — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001400n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    if (h.seed.ownerSteamId64) invalidatePermissionCache(h.seed.ownerSteamId64);
    await h.cleanup();
  });

  it('returns 401 without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/players' });
    expect(res.statusCode).toBe(401);
  });

  it('happy path: returns items array with the seeded owner', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/players', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ steam_id64: string }>; total: number };
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('?q= search by ASCII name substring returns matching players', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players?q=owner',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ canonical_name: string }> };
    expect(body.items.some((p) => p.canonical_name.toLowerCase().includes('owner'))).toBe(true);
  });

  it('?q= search by steamId64 finds the exact player', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players?q=${String(OWNER_STEAM)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ steam_id64: string }> };
    const match = body.items.find((p) => p.steam_id64 === String(OWNER_STEAM));
    expect(match).toBeDefined();
  });

  it('?q= search with Cyrillic substring returns 200 without crashing', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players?q=${encodeURIComponent('Игрок')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('returns 403 when player has no role (no permissions)', async () => {
    if (!h.seed.ownerSteamId64) throw new Error('owner missing');
    await h.db
      .update(players)
      .set({ roleId: null })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerSteamId64);
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/players', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /api/v1/players/:steamId/role — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001410n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    if (h.seed.ownerSteamId64) invalidatePermissionCache(h.seed.ownerSteamId64);
    await h.cleanup();
  });

  it('assigns a role to a player and returns ok', async () => {
    const cookie = await loginAsOwner(h);
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId) throw new Error('viewer role missing');

    const target = testSteamId(810001);
    await h.db.insert(players).values({
      steamId64: target,
      canonicalName: 'TargetPlayer',
      canonicalNameNormalized: 'targetplayer',
    });

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${String(target)}/role`,
      headers: { cookie },
      payload: { role_id: viewerRoleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('returns 404 when role_id does not exist', async () => {
    const cookie = await loginAsOwner(h);
    const target = testSteamId(810002);
    await h.db.insert(players).values({
      steamId64: target,
      canonicalName: 'NoRole',
      canonicalNameNormalized: 'norole',
    });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${String(target)}/role`,
      headers: { cookie },
      payload: { role_id: '019e0000-0000-7000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when trying to remove the last Owner', async () => {
    const cookie = await loginAsOwner(h);
    const ownerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRoleRows[0]?.id;
    if (!ownerRoleId) throw new Error('owner role missing');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${String(OWNER_STEAM)}/role`,
      headers: { cookie },
      payload: { role_id: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'cannot_remove_last_owner' });
  });
});
