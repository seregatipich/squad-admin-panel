import { economySettings, players, roles } from '@squad/db/schema';
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

const OWNER_STEAM = testSteamId(163001);
const MANAGER_STEAM = testSteamId(163002);
const VIEWER_STEAM = testSteamId(163003);
const OUTSIDER_STEAM = testSteamId(163004);

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
  canManageEconomy: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canManageEconomy: opts.canManageEconomy,
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
    userAgent: 'econ3-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'EconOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
  await seedRoleWithPlayer({
    roleName: 'EconManager',
    steamId64: MANAGER_STEAM,
    panelAccess: true,
    canManageEconomy: true,
  });
  await seedRoleWithPlayer({
    roleName: 'EconViewer',
    steamId64: VIEWER_STEAM,
    panelAccess: true,
    canManageEconomy: false,
  });
  await seedRoleWithPlayer({
    roleName: 'EconOutsider',
    steamId64: OUTSIDER_STEAM,
    panelAccess: false,
    canManageEconomy: false,
  });
  managerCookie = await loginAsSteam(MANAGER_STEAM);
  viewerCookie = await loginAsSteam(VIEWER_STEAM);
  outsiderCookie = await loginAsSteam(OUTSIDER_STEAM);
});

afterAll(async () => {
  await h.cleanup();
});

describeIfDb('GET /api/v1/settings/economy', () => {
  it('returns defaults on first load for an owner', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.k_online).toBe(1);
    expect(body.k_boost).toBe(2);
    expect(body.k_seed).toBe(3);
    expect(body.seed_threshold).toBe(40);
    expect(body.economy_enabled).toBe(false);
    expect(body.privilege_costs).toEqual({});
    expect(body.seed_reward_threshold_hours_per_month).toBe(0);
    expect(body.seed_reward_role_id).toBeNull();
  });

  it('allows a panel viewer without can_manage_economy to read', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/economy',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().economy_enabled).toBe(false);
  });

  it('rejects a user without panel access', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/economy',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/settings/economy' });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('PUT /api/v1/settings/economy', () => {
  it('rejects a panel viewer without can_manage_economy with 403', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: viewerCookie },
      payload: { k_boost: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().required).toBe('can_manage_economy');
  });

  it('persists changes and writes an audit row with before/after', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: managerCookie },
      payload: {
        k_online: 1.5,
        k_boost: 4,
        k_seed: 6,
        seed_threshold: 25,
        economy_enabled: true,
        privilege_costs: { 'vip-gold': { days: 30, price: 500 } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.k_online).toBe(1.5);
    expect(body.k_boost).toBe(4);
    expect(body.k_seed).toBe(6);
    expect(body.seed_threshold).toBe(25);
    expect(body.economy_enabled).toBe(true);
    expect(body.privilege_costs).toEqual({ 'vip-gold': { days: 30, price: 500 } });
    expect(body.updated_at).toBeTruthy();

    const persisted = await h.db
      .select()
      .from(economySettings)
      .where(eq(economySettings.id, 1))
      .limit(1);
    expect(persisted[0]?.kBoost).toBe(4);
    expect(persisted[0]?.economyEnabled).toBe(true);

    const audit = await assertAuditRow(h, {
      action: 'economy.settings.update',
      resource: 'economy_settings',
      targetId: '1',
    });
    expect((audit.beforeSnapshot as { k_boost: number }).k_boost).toBe(2);
    expect((audit.afterSnapshot as { k_boost: number }).k_boost).toBe(4);
  });

  it('applies a partial update without touching untouched fields', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: managerCookie },
      payload: { seed_threshold: 60 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seed_threshold).toBe(60);
    expect(body.k_boost).toBe(4);
    expect(body.economy_enabled).toBe(true);
  });

  it('persists seed reward settings for a role without panel access', async () => {
    const rewardRoleId = uuidv7();
    await h.db.insert(roles).values({
      id: rewardRoleId,
      name: `SeedReward_${rewardRoleId}`,
      color: '#8B5CF6',
      panelAccess: false,
    });

    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie },
      payload: {
        seed_reward_threshold_hours_per_month: 12.5,
        seed_reward_role_id: rewardRoleId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      seed_reward_threshold_hours_per_month: 12.5,
      seed_reward_role_id: rewardRoleId,
    });
    const [persisted] = await h.db
      .select({
        threshold: economySettings.seedRewardThresholdHoursPerMonth,
        roleId: economySettings.seedRewardRoleId,
      })
      .from(economySettings)
      .where(eq(economySettings.id, 1));
    expect(persisted).toEqual({ threshold: 12.5, roleId: rewardRoleId });
  });

  it('rejects a seed reward role with panel access with 422', async () => {
    const panelRoleId = uuidv7();
    await h.db.insert(roles).values({
      id: panelRoleId,
      name: `SeedPanelReward_${panelRoleId}`,
      color: '#EF4444',
      panelAccess: true,
    });

    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie },
      payload: { seed_reward_role_id: panelRoleId },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'seed_reward_role_requires_no_panel_access' });
  });

  it('rejects a negative coefficient with 400', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: managerCookie },
      payload: { k_online: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a seed_threshold above the allowed range with 400', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: managerCookie },
      payload: { seed_threshold: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty update with 400', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: managerCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
