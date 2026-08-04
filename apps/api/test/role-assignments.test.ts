import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM = testSteamId(720001);
const VIEWER_STEAM = testSteamId(720002);
const NO_ROLE_STEAM = testSteamId(720003);
const EXPIRING_SOON_EOS_ID = 'eos-role-assignments-test-720005';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('GET /api/v1/role-assignments', () => {
  let h: IntegrationHarness;
  let viewerRoleId: string;

  beforeEach(async () => {
    // Each test gets its own freshly migrated, isolated schema (see
    // buildIntegrationApp), which already seeds the "Viewer" fixture role
    // (helpers/viewer-fixture.ts) — look it up from *this* harness's db,
    // not a shared connection, since the role id differs per schema.
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      seedOwnerGuard: true,
      bridge: makeFakeBridge(),
    });
    const viewerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Viewer'), eq(roles.isSystemRole, false)))
      .limit(1);
    if (!viewerRows[0]) throw new Error('Viewer role not found in isolated schema');
    viewerRoleId = viewerRows[0].id;

    // Viewer with a permanent (null expiry) role assignment.
    await h.db.insert(players).values({
      steamId64: VIEWER_STEAM,
      canonicalName: 'ViewerPermanent',
      canonicalNameNormalized: 'viewerpermanent',
      roleId: viewerRoleId,
      roleExpiresAt: null,
      roleComment: 'Постоянный доступ',
    });

    // Player with no role at all — must never appear in the registry.
    await h.db.insert(players).values({
      steamId64: NO_ROLE_STEAM,
      canonicalName: 'NoRolePlayer',
      canonicalNameNormalized: 'norolerlayer',
      roleId: null,
    });

    // EOS-only player (no linked Steam ID) with a role expiring soon.
    await h.db.insert(players).values({
      steamId64: null,
      eosId: EXPIRING_SOON_EOS_ID,
      canonicalName: 'EosOnlyExpiring',
      canonicalNameNormalized: 'eosonlyexpiring',
      roleId: viewerRoleId,
      roleExpiresAt: new Date(Date.now() + 2 * ONE_DAY_MS),
      roleComment: null,
    });
  });

  afterEach(async () => {
    if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    await h.cleanup();
  });

  it('returns 401 without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/role-assignments' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the caller lacks user:view', async () => {
    if (!h.seed.ownerSteamId64) throw new Error('owner missing');
    await h.db
      .update(players)
      .set({ roleId: null })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    if (!h.seed.ownerPlayerId) throw new Error('owner player missing');
    invalidatePermissionCache(h.seed.ownerPlayerId);
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/role-assignments',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('only returns players with an assigned role, across roles', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/role-assignments',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ steam_id64: string | null; eos_id: string | null }>;

    const steamIds = body.map((r) => r.steam_id64);
    expect(steamIds).toContain(String(OWNER_STEAM));
    expect(steamIds).toContain(String(VIEWER_STEAM));
    expect(steamIds).not.toContain(String(NO_ROLE_STEAM));

    const eosOnly = body.find((r) => r.eos_id === EXPIRING_SOON_EOS_ID);
    expect(eosOnly).toBeDefined();
    expect(eosOnly?.steam_id64).toBeNull();
  });

  it('reports role badge, expiry, and comment fields correctly', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/role-assignments',
      headers: { cookie },
    });
    const body = res.json() as Array<{
      steam_id64: string | null;
      canonical_name: string;
      role: { id: string; name: string; color: string };
      role_expires_at: string | null;
      role_comment: string | null;
      last_seen_at: string;
    }>;

    const viewer = body.find((r) => r.steam_id64 === String(VIEWER_STEAM));
    expect(viewer).toBeDefined();
    expect(viewer?.role).toMatchObject({ id: viewerRoleId, name: 'Viewer' });
    expect(viewer?.role_expires_at).toBeNull();
    expect(viewer?.role_comment).toBe('Постоянный доступ');
    expect(typeof viewer?.last_seen_at).toBe('string');

    const owner = body.find((r) => r.steam_id64 === String(OWNER_STEAM));
    expect(owner?.role.name).toBe('Owner');
  });

  it('filters by role_id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/role-assignments?role_id=${viewerRoleId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ role: { id: string } }>;
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row.role.id).toBe(viewerRoleId);
    }
  });

  it('expiring_soon=true only returns time-limited grants inside the window', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/role-assignments?expiring_soon=true',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      steam_id64: string | null;
      eos_id: string | null;
      role_expires_at: string | null;
    }>;

    const eosOnly = body.find((r) => r.eos_id === EXPIRING_SOON_EOS_ID);
    expect(eosOnly).toBeDefined();
    expect(eosOnly?.role_expires_at).not.toBeNull();

    // The permanent Viewer assignment (null expiry) must not appear.
    expect(body.some((r) => r.steam_id64 === String(VIEWER_STEAM))).toBe(false);
    // The Owner's default seed assignment has no expiry either.
    expect(body.some((r) => r.steam_id64 === String(OWNER_STEAM))).toBe(false);
  });
});
