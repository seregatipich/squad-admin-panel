import * as schema from '@squad/db/schema';
import { players, roles } from '@squad/db/schema';
import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let viewerRoleId: string;

const TEST_PLAYER_WITH_ROLE = testSteamId(700001);
const TEST_PLAYER_WITHOUT_ROLE = testSteamId(700002);

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  sql = postgres(dbUrl, { max: 3, onnotice: () => undefined });
  db = drizzle(sql, { schema });

  const { ensureViewerFixture } = await import('./helpers/viewer-fixture.js');
  await ensureViewerFixture(db as unknown as Parameters<typeof ensureViewerFixture>[0]);

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
  for (const [sid, roleId] of [
    [TEST_PLAYER_WITH_ROLE, viewerRoleId],
    [TEST_PLAYER_WITHOUT_ROLE, null],
  ] as const) {
    const stub = `TestUser${String(sid).slice(-4)}`;
    await db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId: roleId ?? null,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId: roleId ?? null } });
  }
});

afterEach(async () => {
  for (const sid of [TEST_PLAYER_WITH_ROLE, TEST_PLAYER_WITHOUT_ROLE]) {
    await db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));
    await db.delete(players).where(eq(players.steamId64, sid));
  }
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('users list — role_id NOT NULL filter', () => {
  it('players with role_id set appear in joined query', async () => {
    const usersWithRole = await db
      .select({
        steamId64: players.steamId64,
        roleId: players.roleId,
        roleName: roles.name,
      })
      .from(players)
      .innerJoin(roles, eq(roles.id, players.roleId))
      .where(and(eq(players.steamId64, TEST_PLAYER_WITH_ROLE)));

    expect(usersWithRole.length).toBe(1);
    expect(usersWithRole[0]?.roleId).toBe(viewerRoleId);
    expect(usersWithRole[0]?.roleName).toBe('Viewer');
  });

  it('players without role_id do not appear in joined query', async () => {
    const usersWithRole = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .innerJoin(roles, eq(roles.id, players.roleId))
      .where(eq(players.steamId64, TEST_PLAYER_WITHOUT_ROLE));

    expect(usersWithRole.length).toBe(0);
  });

  it('both players exist in the players table', async () => {
    const all = await db
      .select({ steamId64: players.steamId64, roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_WITH_ROLE));
    expect(all[0]?.roleId).toBe(viewerRoleId);

    const noRole = await db
      .select({ steamId64: players.steamId64, roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, TEST_PLAYER_WITHOUT_ROLE));
    expect(noRole[0]?.roleId).toBeNull();
  });
});

describeIfDb('GET /api/v1/users — HTTP integration', () => {
  const OWNER_STEAM = 76561198000001300n;
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
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(res.statusCode).toBe(401);
  });

  it('happy path: owner has a role and appears in the list', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      steam_id64: string;
      role: { name: string };
    }>;
    expect(Array.isArray(body)).toBe(true);
    const owner = body.find((u) => u.steam_id64 === String(OWNER_STEAM));
    expect(owner).toBeDefined();
    expect(owner?.role.name).toBe('Owner');
  });

  it('returns role expiry/comment metadata for active role assignments', async () => {
    const cookie = await loginAsOwner(h);
    const ownerPlayerId = h.seed.ownerPlayerId;
    if (!ownerPlayerId) throw new Error('owner player missing');
    const expiresAt = '2026-08-02T18:30:00.000Z';
    const comment = 'Срочная VIP-роль по заявке штаба';
    await h.db.execute(drizzleSql`
      UPDATE players
      SET role_expires_at = ${expiresAt}::timestamptz,
          role_comment = ${comment}
      WHERE id = ${ownerPlayerId}::uuid
    `);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      steam_id64: string;
      role_expires_at: string | null;
      role_comment: string | null;
    }>;
    const owner = body.find((u) => u.steam_id64 === String(OWNER_STEAM));
    expect(owner).toMatchObject({
      role_expires_at: expiresAt,
      role_comment: comment,
    });
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
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('role.name is null-safe when player has no role (LEFT JOIN scenario)', async () => {
    const cookie = await loginAsOwner(h);
    const stubSteam = testSteamId(710001);
    await h.db.insert(players).values({
      steamId64: stubSteam,
      canonicalName: 'NoRoleUser',
      canonicalNameNormalized: 'noroleuser',
      roleId: null,
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ steam_id64: string }>;
    const found = body.find((u) => u.steam_id64 === String(stubSteam));
    expect(found).toBeUndefined();
  });
});
