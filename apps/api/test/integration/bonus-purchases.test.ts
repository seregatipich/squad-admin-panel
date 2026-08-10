import { randomUUID } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  bonusTransactions,
  economySettings,
  players,
  roles,
  servers,
  vipTiers,
} from '@squad/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMINS_CFG_SYNC_STREAM_PREFIX } from '../../src/lib/admins-cfg-sync.js';
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

const OWNER_STEAM = testSteamId(830001);
const ECON_ONLY_STEAM = testSteamId(830002);
const ASSIGN_ONLY_STEAM = testSteamId(830003);

const DAY_MS = 86_400_000;
const TIER_PRICE = 100;
const TIER_DAYS = 30;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let econOnlyCookie: string;
let assignOnlyCookie: string;

let vipRoleId: string;
let otherRoleId: string;
let panelRoleId: string;
let serverId: string;

let tierId: string;
let freeTierId: string;
let inactiveTierId: string;
let panelTierId: string;

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
    userAgent: 'bonus-purchases-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(
  steamOffset: number,
  name: string,
  role: { roleId: string; roleExpiresAt: Date | null } | null = null,
): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamOffset),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId: role?.roleId ?? null,
      roleExpiresAt: role?.roleExpiresAt ?? null,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function credit(playerId: string, amount: number): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/players/${playerId}/bonus-adjustments`,
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ amount, comment: 'test credit' }),
  });
  if (res.statusCode !== 201) throw new Error(`credit failed: ${res.statusCode} ${res.body}`);
}

async function storedPlayer(
  playerId: string,
): Promise<{ balance: number; roleId: string | null; roleExpiresAt: Date | null }> {
  const rows = await h.db
    .select({
      balance: players.bonusBalance,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
    })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`player ${playerId} vanished`);
  return row;
}

async function spendRows(
  playerId: string,
): Promise<Array<{ amount: number; referenceType: string | null; referenceId: string | null }>> {
  return h.db
    .select({
      amount: bonusTransactions.amount,
      referenceType: bonusTransactions.referenceType,
      referenceId: bonusTransactions.referenceId,
    })
    .from(bonusTransactions)
    .where(and(eq(bonusTransactions.playerId, playerId), eq(bonusTransactions.type, 'spend')));
}

function purchase(playerId: string, tier: string, cookie = ownerCookie) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/players/${playerId}/bonus-purchases`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ tier_id: tier }),
  });
}

function expectCloseTo(actual: Date | null, expectedMs: number, toleranceMs = 120_000): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as Date).getTime() - expectedMs)).toBeLessThan(toleranceMs);
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'ShopOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  await h.db.update(economySettings).set({ economyEnabled: true }).where(eq(economySettings.id, 1));

  const [srv] = await h.db
    .insert(servers)
    .values({
      id: uuidv7(),
      displayName: 'bonus-shop-test-server',
      slug: `bonus-shop-${Date.now()}`,
    })
    .returning({ id: servers.id });
  if (!srv) throw new Error('failed to seed server');
  serverId = srv.id;

  vipRoleId = randomUUID();
  otherRoleId = randomUUID();
  panelRoleId = randomUUID();
  await h.db.insert(roles).values([
    { id: vipRoleId, name: 'ShopVip', panelAccess: false },
    { id: otherRoleId, name: 'ShopOther', panelAccess: false },
    { id: panelRoleId, name: 'ShopPanel', panelAccess: true },
  ]);

  const insertTier = async (values: {
    name: string;
    roleId: string;
    defaultDays?: number | null;
    priceBonuses?: number | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<string> => {
    const id = uuidv7();
    await h.db.insert(vipTiers).values({
      id,
      name: values.name,
      roleId: values.roleId,
      defaultDays: values.defaultDays ?? null,
      priceBonuses: values.priceBonuses ?? null,
      isActive: values.isActive ?? true,
      sortOrder: values.sortOrder ?? 0,
    });
    return id;
  };

  tierId = await insertTier({
    name: 'Shop Bronze',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: TIER_PRICE,
    sortOrder: 10,
  });
  freeTierId = await insertTier({
    name: 'Shop Unpriced',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    sortOrder: 20,
  });
  inactiveTierId = await insertTier({
    name: 'Shop Hidden',
    roleId: vipRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: 50,
    isActive: false,
    sortOrder: 30,
  });
  panelTierId = await insertTier({
    name: 'Shop Panel',
    roleId: panelRoleId,
    defaultDays: TIER_DAYS,
    priceBonuses: 50,
    sortOrder: 40,
  });

  const [econOnlyRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'ShopEconOnly',
      panelAccess: true,
      canManageEconomy: true,
      canAssignRoles: false,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: ECON_ONLY_STEAM,
    canonicalName: 'ShopEconOnly',
    canonicalNameNormalized: 'shopecononly',
    roleId: econOnlyRole?.id ?? null,
  });
  econOnlyCookie = await loginAsSteam(ECON_ONLY_STEAM);

  const [assignOnlyRole] = await h.db
    .insert(roles)
    .values({
      id: randomUUID(),
      name: 'ShopAssignOnly',
      panelAccess: true,
      canManageEconomy: false,
      canAssignRoles: true,
    })
    .returning({ id: roles.id });
  await h.db.insert(players).values({
    steamId64: ASSIGN_ONLY_STEAM,
    canonicalName: 'ShopAssignOnly',
    canonicalNameNormalized: 'shopassignonly',
    roleId: assignOnlyRole?.id ?? null,
  });
  assignOnlyCookie = await loginAsSteam(ASSIGN_ONLY_STEAM);
}, 120_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('POST /api/v1/players/:playerId/bonus-purchases (ECON-6)', () => {
  it('purchase debits exactly the price, grants the role for default_days and publishes the admins-cfg sync', async () => {
    const buyerId = await seedPlayer(830010, 'ShopBuyer');
    await credit(buyerId, 250);
    const before = Date.now();

    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      ok: boolean;
      balance: number;
      role_id: string;
      role_expires_at: string;
    };
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(250 - TIER_PRICE);
    expect(body.role_id).toBe(vipRoleId);
    expectCloseTo(new Date(body.role_expires_at), before + TIER_DAYS * DAY_MS);

    const ledger = await spendRows(buyerId);
    expect(ledger).toEqual([
      { amount: -TIER_PRICE, referenceType: 'purchase', referenceId: tierId },
    ]);

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(250 - TIER_PRICE);
    expect(stored.roleId).toBe(vipRoleId);
    expectCloseTo(stored.roleExpiresAt, before + TIER_DAYS * DAY_MS);

    // SYNC-3: the grant enqueued a durable outbox row per active server and
    // the immediate best-effort publish put an entry on the server's stream.
    const activeServers = await h.db
      .select({ id: servers.id })
      .from(servers)
      .where(isNull(servers.deletedAt));
    const outboxRows = await h.db
      .select({ serverId: adminsCfgSyncOutbox.serverId, payload: adminsCfgSyncOutbox.payload })
      .from(adminsCfgSyncOutbox);
    const assignRows = outboxRows.filter(
      (r) => (r.payload as { reason?: string }).reason === 'player.role.assign',
    );
    expect(assignRows.length).toBe(activeServers.length);
    expect(assignRows.map((r) => r.serverId)).toContain(serverId);
    expect(
      await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`),
    ).toBeGreaterThanOrEqual(1);
  });

  it('writes the player.bonus.purchase audit row', async () => {
    const buyerId = await seedPlayer(830011, 'ShopAuditBuyer');
    await credit(buyerId, 150);
    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(201);

    const row = await assertAuditRow(h, {
      action: 'player.bonus.purchase',
      resource: 'player',
      targetId: buyerId,
    });
    expect(row.actorKind).toBe('steam');
    expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
  });

  it('insufficient balance → 409 with no changes', async () => {
    const buyerId = await seedPlayer(830012, 'ShopPoorBuyer');
    await credit(buyerId, TIER_PRICE - 1);

    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'insufficient_balance', balance: TIER_PRICE - 1 });

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(TIER_PRICE - 1);
    expect(stored.roleId).toBeNull();
    expect(stored.roleExpiresAt).toBeNull();
    expect(await spendRows(buyerId)).toEqual([]);
  });

  it('two concurrent purchases never drive the balance negative', async () => {
    const buyerId = await seedPlayer(830013, 'ShopRaceBuyer');
    await credit(buyerId, 150);

    const [a, b] = await Promise.all([purchase(buyerId, tierId), purchase(buyerId, tierId)]);
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    const rejected = a.statusCode === 409 ? a : b;
    expect(rejected.json()).toMatchObject({ error: 'insufficient_balance' });

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(150 - TIER_PRICE);
    expect(stored.roleId).toBe(vipRoleId);
    expect(await spendRows(buyerId)).toHaveLength(1);
  });

  it('extends the same active role by default_days', async () => {
    const buyerId = await seedPlayer(830014, 'ShopExtendBuyer');
    await credit(buyerId, 300);
    const before = Date.now();

    const first = await purchase(buyerId, tierId);
    expect(first.statusCode).toBe(201);
    const second = await purchase(buyerId, tierId);
    expect(second.statusCode).toBe(201);
    const body = second.json() as { balance: number; role_expires_at: string };
    expect(body.balance).toBe(300 - 2 * TIER_PRICE);
    expectCloseTo(new Date(body.role_expires_at), before + 2 * TIER_DAYS * DAY_MS);

    const stored = await storedPlayer(buyerId);
    expectCloseTo(stored.roleExpiresAt, before + 2 * TIER_DAYS * DAY_MS);
    expect(await spendRows(buyerId)).toHaveLength(2);
  });

  it('permanent grant → 409 role_permanent', async () => {
    const buyerId = await seedPlayer(830015, 'ShopPermanent', {
      roleId: vipRoleId,
      roleExpiresAt: null,
    });
    await credit(buyerId, 200);

    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'role_permanent' });

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(200);
    expect(stored.roleExpiresAt).toBeNull();
    expect(await spendRows(buyerId)).toEqual([]);
  });

  it('different current role → 409 role_conflict', async () => {
    const buyerId = await seedPlayer(830016, 'ShopConflict', {
      roleId: otherRoleId,
      roleExpiresAt: new Date(Date.now() + 10 * DAY_MS),
    });
    await credit(buyerId, 200);

    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'role_conflict' });

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(200);
    expect(stored.roleId).toBe(otherRoleId);
    expect(await spendRows(buyerId)).toEqual([]);
  });

  it('tier without price → 409 tier_not_purchasable', async () => {
    const buyerId = await seedPlayer(830017, 'ShopFreeBuyer');
    await credit(buyerId, 200);

    const res = await purchase(buyerId, freeTierId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'tier_not_purchasable' });

    const missing = await purchase(buyerId, '00000000-0000-7000-8000-000000000166');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'tier_not_found' });
  });

  it('panel-access tier → 403 role_grants_panel_access', async () => {
    const buyerId = await seedPlayer(830018, 'ShopPanelBuyer');
    await credit(buyerId, 200);

    const res = await purchase(buyerId, panelTierId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'role_grants_panel_access' });

    const stored = await storedPlayer(buyerId);
    expect(stored.balance).toBe(200);
    expect(stored.roleId).toBeNull();
    expect(await spendRows(buyerId)).toEqual([]);
  });

  it('economy disabled → 409 economy_disabled', async () => {
    const buyerId = await seedPlayer(830019, 'ShopDisabledBuyer');
    await credit(buyerId, 200);
    await h.db
      .update(economySettings)
      .set({ economyEnabled: false })
      .where(eq(economySettings.id, 1));
    try {
      const res = await purchase(buyerId, tierId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'economy_disabled' });
    } finally {
      await h.db
        .update(economySettings)
        .set({ economyEnabled: true })
        .where(eq(economySettings.id, 1));
    }
    expect((await storedPlayer(buyerId)).balance).toBe(200);
  });

  it('requires both can_manage_economy and can_assign_roles', async () => {
    const buyerId = await seedPlayer(830020, 'ShopGuardBuyer');
    await credit(buyerId, 200);

    const unauthenticated = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${buyerId}/bonus-purchases`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ tier_id: tierId }),
    });
    expect(unauthenticated.statusCode).toBe(401);

    const econOnly = await purchase(buyerId, tierId, econOnlyCookie);
    expect(econOnly.statusCode).toBe(403);
    expect(econOnly.json()).toEqual({ error: 'forbidden', required: 'can_assign_roles' });

    const assignOnly = await purchase(buyerId, tierId, assignOnlyCookie);
    expect(assignOnly.statusCode).toBe(403);
    expect(assignOnly.json()).toEqual({ error: 'forbidden', required: 'can_manage_economy' });

    expect((await storedPlayer(buyerId)).roleId).toBeNull();
  });
});

describeIfDb('GET /api/v1/bonus-shop/tiers (ECON-6)', () => {
  it('bonus-shop listing returns only active priced tiers', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/bonus-shop/tiers',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const tiers = (res.json() as { tiers: Array<{ id: string; price_bonuses: number }> }).tiers;
    const ids = tiers.map((t) => t.id);
    expect(ids).toContain(tierId);
    expect(ids).toContain(panelTierId);
    expect(ids).not.toContain(freeTierId);
    expect(ids).not.toContain(inactiveTierId);
    const mine = tiers.find((t) => t.id === tierId);
    expect(mine).toMatchObject({
      id: tierId,
      name: 'Shop Bronze',
      role_id: vipRoleId,
      default_days: TIER_DAYS,
      price_bonuses: TIER_PRICE,
      is_active: true,
    });

    // Ordered by sort_order then name: Bronze (10) precedes Panel (40).
    expect(ids.indexOf(tierId)).toBeLessThan(ids.indexOf(panelTierId));

    const unauthenticated = await h.app.inject({ method: 'GET', url: '/api/v1/bonus-shop/tiers' });
    expect(unauthenticated.statusCode).toBe(401);
  });
});

describeIfDb('bonus purchase count sanity', () => {
  it('spend rows appear in the ledger listing with the purchase source', async () => {
    const buyerId = await seedPlayer(830021, 'ShopLedgerBuyer');
    await credit(buyerId, 150);
    const res = await purchase(buyerId, tierId);
    expect(res.statusCode).toBe(201);

    const list = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${buyerId}/bonus-transactions?type=spend`,
      headers: { cookie: ownerCookie },
    });
    expect(list.statusCode).toBe(200);
    const items = (
      list.json() as {
        items: Array<{
          amount: number;
          type: string;
          reference_type: string | null;
          reference_id: string | null;
          actor_player_id: string | null;
        }>;
      }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      amount: -TIER_PRICE,
      type: 'spend',
      reference_type: 'purchase',
      reference_id: tierId,
      actor_player_id: h.seed.ownerPlayerId,
    });

    const count = await h.db
      .select({ c: sql<number>`count(*)::int` })
      .from(bonusTransactions)
      .where(and(eq(bonusTransactions.playerId, buyerId), eq(bonusTransactions.type, 'spend')));
    expect(count[0]?.c).toBe(1);
  });
});
