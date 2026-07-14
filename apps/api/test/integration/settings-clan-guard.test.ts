import { clanGuardSettings, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(164001);
const MANAGER_STEAM = testSteamId(164002);
const VIEWER_STEAM = testSteamId(164003);
const OUTSIDER_STEAM = testSteamId(164004);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let managerCookie: string;
let viewerCookie: string;
let outsiderCookie: string;

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  panelAccess: boolean;
  canManageClans: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canManageClans: opts.canManageClans,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  await h.db.insert(players).values({
    steamId64: opts.steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'clanguard-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'ClanGuardOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
  await seedRoleWithPlayer({
    roleName: 'ClanGuardManager',
    steamId64: MANAGER_STEAM,
    panelAccess: true,
    canManageClans: true,
  });
  await seedRoleWithPlayer({
    roleName: 'ClanGuardViewer',
    steamId64: VIEWER_STEAM,
    panelAccess: true,
    canManageClans: false,
  });
  await seedRoleWithPlayer({
    roleName: 'ClanGuardOutsider',
    steamId64: OUTSIDER_STEAM,
    panelAccess: false,
    canManageClans: false,
  });
  managerCookie = await loginAsSteam(MANAGER_STEAM);
  viewerCookie = await loginAsSteam(VIEWER_STEAM);
  outsiderCookie = await loginAsSteam(OUTSIDER_STEAM);
});

afterAll(async () => {
  await h.cleanup();
});

describeIfDb('GET /api/v1/settings/clan-guard', () => {
  it('returns seeded defaults for an owner', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.grace_period_seconds).toBe(300);
  });

  it('allows a panel viewer without can_manage_clans to read', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it('rejects a user without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/settings/clan-guard' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
  });
});

describeIfDb('PATCH /api/v1/settings/clan-guard', () => {
  it('rejects a panel viewer without can_manage_clans with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: viewerCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthenticated');
  });

  it('persists enabled=false and GET reflects it, and writes an audit row', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: managerCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);

    const getRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: ownerCookie },
    });
    expect(getRes.json().enabled).toBe(false);

    const persisted = await h.db
      .select()
      .from(clanGuardSettings)
      .where(eq(clanGuardSettings.id, 1))
      .limit(1);
    expect(persisted[0]?.enabled).toBe(false);

    const audit = await assertAuditRow(h, {
      action: 'clan_guard.settings.update',
      resource: 'clan_guard_settings',
      targetId: '1',
    });
    expect((audit.beforeSnapshot as { enabled: boolean }).enabled).toBe(true);
    expect((audit.afterSnapshot as { enabled: boolean }).enabled).toBe(false);
  });

  it('persists grace_period_seconds', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: managerCookie },
      payload: { grace_period_seconds: 600 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grace_period_seconds).toBe(600);
  });

  it('rejects an empty update with 400', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: managerCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a negative grace_period_seconds with 400', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: managerCookie },
      payload: { grace_period_seconds: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a grace_period_seconds above the allowed range with 400', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/clan-guard',
      headers: { cookie: managerCookie },
      payload: { grace_period_seconds: 3601 },
    });
    expect(res.statusCode).toBe(400);
  });
});
