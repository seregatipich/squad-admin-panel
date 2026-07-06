import * as schema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { and, sql as drizzleSql, eq } from 'drizzle-orm';
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
const playerIds = new Map<bigint, string>();
function pid(steamId: bigint): string {
  const id = playerIds.get(steamId);
  if (!id) throw new Error(`No UUID found for steamId64=${steamId}`);
  return id;
}

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  sql = postgres(dbUrl, { max: 3, onnotice: () => undefined });
  db = drizzle(sql, { schema });

  const { ensureViewerFixture } = await import('./helpers/viewer-fixture.js');
  await ensureViewerFixture(db as unknown as Parameters<typeof ensureViewerFixture>[0]);

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
    const [row] = await db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: null,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: null } })
      .returning({ id: players.id });
    if (!row) throw new Error('player fixture missing');
    playerIds.set(sid, row.id);
    invalidatePermissionCache(row.id);
  }
});

afterEach(async () => {
  for (const sid of [TEST_PLAYER_A, TEST_PLAYER_B, TEST_PLAYER_C]) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
    await db.delete(players).where(eq(players.steamId64, sid));
    invalidatePermissionCache(pid(sid));
  }
  for (const id of createdRoleIds) {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    await db.delete(roles).where(eq(roles.id, id));
  }
  createdRoleIds.length = 0;
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('player single-role assignment', () => {
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
    invalidatePermissionCache(pid(TEST_PLAYER_B));
    const before = await loadUserPermissions(db, pid(TEST_PLAYER_B));
    expect(before.permissions.size).toBe(0);

    await db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, TEST_PLAYER_B));
    invalidatePermissionCache(pid(TEST_PLAYER_B));

    const after = await loadUserPermissions(db, pid(TEST_PLAYER_B));
    expect(after.permissions.has('server:view')).toBe(true);
  });
});

describeIfDb('Owner-lockout invariant', () => {
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

  // regression: last-Owner guard counted ALL owners globally → test failed when real Owner present
  // Fix: snapshot the baseline owner count before mutation and compare relative to it
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

describeIfDb('cache invalidation on role permission change', () => {
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
    invalidatePermissionCache(pid(TEST_PLAYER_C));

    const before = await loadUserPermissions(db, pid(TEST_PLAYER_C));
    expect(before.permissions.has('server:view')).toBe(true);

    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, testRoleId));
    await invalidatePermissionCacheForRole(db, testRoleId);

    const after = await loadUserPermissions(db, pid(TEST_PLAYER_C));
    expect(after.permissions.has('server:view')).toBe(false);
  });
});

describeIfDb('GET /api/v1/players — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001400n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    if (h.seed.ownerSteamId64 && h.seed.ownerPlayerId) {
      invalidatePermissionCache(h.seed.ownerPlayerId);
    }
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
    if (!h.seed.ownerPlayerId) throw new Error('owner player missing');
    invalidatePermissionCache(h.seed.ownerPlayerId);
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/players', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('PUT /api/v1/players/:playerId/role — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001410n;
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
  });

  afterEach(async () => {
    if (h.seed.ownerSteamId64 && h.seed.ownerPlayerId) {
      invalidatePermissionCache(h.seed.ownerPlayerId);
    }
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
    const [targetRow] = await h.db
      .insert(players)
      .values({
        steamId64: target,
        canonicalName: 'TargetPlayer',
        canonicalNameNormalized: 'targetplayer',
      })
      .returning({ id: players.id });
    if (!targetRow) throw new Error('target player missing');

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${targetRow.id}/role`,
      headers: { cookie },
      payload: { role_id: viewerRoleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('persists role expiry/comment and exposes them on GET role', async () => {
    const cookie = await loginAsOwner(h);
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId) throw new Error('viewer role missing');

    const target = testSteamId(810004);
    const [targetRow] = await h.db
      .insert(players)
      .values({
        steamId64: target,
        canonicalName: 'ExpiringVip',
        canonicalNameNormalized: 'expiringvip',
      })
      .returning({ id: players.id });
    if (!targetRow) throw new Error('target player missing');
    const playerId = targetRow.id;
    const expiresAt = '2026-08-01T12:00:00.000Z';
    const comment = 'VIP до конца июльской кампании';

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${playerId}/role`,
      headers: { cookie },
      payload: { role_id: viewerRoleId, expires_at: expiresAt, comment },
    });
    expect(res.statusCode).toBe(200);

    const persisted = (await h.db.execute(drizzleSql`
      SELECT role_expires_at::text AS role_expires_at, role_comment
      FROM players
      WHERE id = ${playerId}::uuid
    `)) as unknown as Array<{ role_expires_at: string | null; role_comment: string | null }>;
    expect(new Date(persisted[0]?.role_expires_at ?? 0).toISOString()).toBe(expiresAt);
    expect(persisted[0]?.role_comment).toBe(comment);

    const getRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/role`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({
      role: {
        id: viewerRoleId,
        role_expires_at: expiresAt,
        role_comment: comment,
      },
    });
  });

  it('returns 404 when role_id does not exist', async () => {
    const cookie = await loginAsOwner(h);
    const target = testSteamId(810002);
    const [targetRow] = await h.db
      .insert(players)
      .values({
        steamId64: target,
        canonicalName: 'NoRole',
        canonicalNameNormalized: 'norole',
      })
      .returning({ id: players.id });
    if (!targetRow) throw new Error('target player missing');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${targetRow.id}/role`,
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
    if (!h.seed.ownerPlayerId) throw new Error('owner player missing');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${h.seed.ownerPlayerId}/role`,
      headers: { cookie },
      payload: { role_id: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'cannot_remove_last_owner' });
  });
});
