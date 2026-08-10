import type { DatabaseClient } from '@squad/db';
import { players, roles, vipTiers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198200000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 7_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

const createdTierIds: string[] = [];
const createdRoleIds: string[] = [];
const createdPlayerIds: string[] = [];
// Track each seeded player's steamId64 so cleanup/mutations can be scoped by
// steamId64 (unique per player) — the test-isolation guard only recognizes
// player mutations filtered by steamId64, not by uuid.
const playerSteams = new Map<string, bigint>();

async function seedRole(
  db: DatabaseClient,
  opts: { panelAccess?: boolean; canEditRoles?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `VipTierRole-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? false,
    canEditRoles: opts.canEditRoles ?? false,
  });
  createdRoleIds.push(id);
  return id;
}

async function seedPlayer(
  db: DatabaseClient,
  roleId: string | null,
  roleExpiresAt: Date | null = null,
): Promise<string> {
  const id = uuidv7();
  const sid = nextSteam();
  const name = `VipTierUser-${id.slice(0, 8)}`;
  await db.insert(players).values({
    id,
    steamId64: sid,
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId,
    roleExpiresAt,
  });
  createdPlayerIds.push(id);
  playerSteams.set(id, sid);
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'vip-tiers-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

describeIfDb('vip-tiers API (VIPSUB-3)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let tierRoleId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);
    tierRoleId = await seedRole(h.db, { panelAccess: true });
  });

  afterAll(async () => {
    for (const id of createdTierIds) {
      await h.db.delete(vipTiers).where(eq(vipTiers.id, id));
    }
    for (const id of createdPlayerIds) {
      const sid = playerSteams.get(id);
      if (sid !== undefined) {
        await h.db.delete(players).where(eq(players.steamId64, sid));
      }
    }
    for (const id of createdRoleIds) {
      await h.db.delete(roles).where(eq(roles.id, id));
    }
    await h.cleanup();
  });

  it('rejects an unauthenticated list with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/vip-tiers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a role without can_edit_roles', async () => {
    const role = await seedRole(h.db, { panelAccess: true, canEditRoles: false });
    const player = await seedPlayer(h.db, role);
    const cookie = await loginAs(h, player);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie },
      payload: { name: 'Nope', role_id: tierRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ required: 'can_edit_roles' });
  });

  it('rejects creation referencing a non-existent role with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: 'Ghost', role_id: uuidv7() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'role_not_found' });
  });

  it('creates a tier, lists it, and writes a create audit row', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: {
        name: 'VIP Bronze',
        role_id: tierRoleId,
        description: 'reserve only',
        default_days: 30,
        sort_order: 10,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; role_id: string; is_active: boolean };
    createdTierIds.push(created.id);
    expect(created).toMatchObject({
      name: 'VIP Bronze',
      role_id: tierRoleId,
      default_days: 30,
      sort_order: 10,
      is_active: true,
    });

    const audit = await assertAuditRow(h, {
      action: 'vip_tier.create',
      resource: 'vip_tier',
      targetId: created.id,
    });
    expect(audit.beforeSnapshot).toBeNull();
    expect(audit.afterSnapshot).toMatchObject({ name: 'VIP Bronze' });

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { rows: Array<{ id: string; name: string }> }).rows;
    expect(rows.find((r) => r.id === created.id)?.name).toBe('VIP Bronze');
  });

  it('rejects a duplicate tier name with 409', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: 'VIP Bronze', role_id: tierRoleId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'vip_tier_name_taken' });
  });

  it('deactivating a tier hides it from the shop without touching issued roles', async () => {
    // Grant the tier's role to a player (as VIPSUB-1 would).
    const holder = await seedPlayer(h.db, tierRoleId);

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: 'VIP Silver', role_id: tierRoleId },
    });
    const tier = created.json() as { id: string };
    createdTierIds.push(tier.id);

    const update = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
      payload: { is_active: false },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ is_active: false });

    await assertAuditRow(h, { action: 'vip_tier.update', resource: 'vip_tier', targetId: tier.id });

    // The already-granted role is untouched by deactivation.
    const holderRow = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, holder))
      .limit(1);
    expect(holderRow[0]?.roleId).toBe(tierRoleId);
  });

  it('refuses to delete a tier with active assignments (409) and allows it once cleared', async () => {
    const deleteRoleId = await seedRole(h.db, { panelAccess: true });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: 'VIP Gold', role_id: deleteRoleId },
    });
    const tier = created.json() as { id: string };
    createdTierIds.push(tier.id);

    const holder = await seedPlayer(h.db, deleteRoleId);

    const blocked = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'vip_tier_has_active_assignments' });

    // Clear the assignment; deletion is now permitted. Scope by steamId64 (the
    // test-isolation guard only recognizes player mutations filtered that way).
    const sid = playerSteams.get(holder) as bigint;
    await h.db.update(players).set({ roleId: null }).where(eq(players.steamId64, sid));

    const ok = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });

    await assertAuditRow(h, { action: 'vip_tier.delete', resource: 'vip_tier', targetId: tier.id });

    const gone = await h.db.select().from(vipTiers).where(eq(vipTiers.id, tier.id)).limit(1);
    expect(gone.length).toBe(0);
  });

  it('refuses to delete a role referenced by a VIP tier (409) and keeps the role', async () => {
    // Regression (#169, VIPSUB-3): vip_tiers.role_id is ON DELETE RESTRICT
    // (migration 0035). Deleting a referenced role used to surface the raw
    // Postgres FK violation as a 500; it must be a clean 409 instead.
    const referencedRoleId = await seedRole(h.db, { panelAccess: true });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: `VIP FK Guard ${uuidv7()}`, role_id: referencedRoleId },
    });
    expect(created.statusCode).toBe(201);
    createdTierIds.push((created.json() as { id: string }).id);

    const blocked = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${referencedRoleId}`,
      headers: { cookie: ownerCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'role_referenced_by_vip_tier' });

    // The rejected delete must leave the role intact.
    const stillThere = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, referencedRoleId))
      .limit(1);
    expect(stillThere.length).toBe(1);
  });

  it('deletes a role with no referencing VIP tier (200 ok)', async () => {
    const freeRoleId = await seedRole(h.db, { panelAccess: true });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${freeRoleId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const gone = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, freeRoleId))
      .limit(1);
    expect(gone.length).toBe(0);
  });

  it('round-trips price_bonuses through create and update', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: {
        name: `VIP Priced ${uuidv7()}`,
        role_id: tierRoleId,
        default_days: 30,
        price_bonuses: 500,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; price_bonuses: number | null };
    createdTierIds.push(created.id);
    expect(created.price_bonuses).toBe(500);

    const update = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${created.id}`,
      headers: { cookie: ownerCookie },
      payload: { price_bonuses: 750 },
    });
    expect(update.statusCode).toBe(200);
    expect((update.json() as { price_bonuses: number | null }).price_bonuses).toBe(750);

    const cleared = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${created.id}`,
      headers: { cookie: ownerCookie },
      payload: { price_bonuses: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { price_bonuses: number | null }).price_bonuses).toBeNull();

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
    });
    const row = (
      list.json() as { rows: Array<{ id: string; price_bonuses: number | null }> }
    ).rows.find((r) => r.id === created.id);
    expect(row?.price_bonuses).toBeNull();
  });

  it('rejects price without default_days (price_requires_days)', async () => {
    const createNoDays = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: `VIP NoDays ${uuidv7()}`, role_id: tierRoleId, price_bonuses: 100 },
    });
    expect(createNoDays.statusCode).toBe(422);
    expect(createNoDays.json()).toMatchObject({ error: 'price_requires_days' });

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: `VIP DaysGuard ${uuidv7()}`, role_id: tierRoleId, default_days: 30 },
    });
    expect(created.statusCode).toBe(201);
    const tier = created.json() as { id: string };
    createdTierIds.push(tier.id);

    // Setting a price while simultaneously clearing default_days must fail.
    const bothInvalid = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
      payload: { price_bonuses: 100, default_days: null },
    });
    expect(bothInvalid.statusCode).toBe(422);
    expect(bothInvalid.json()).toMatchObject({ error: 'price_requires_days' });

    // Give it a price, then try to clear default_days alone — also refused.
    const priced = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
      payload: { price_bonuses: 100 },
    });
    expect(priced.statusCode).toBe(200);
    const clearDays = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
      payload: { default_days: null },
    });
    expect(clearDays.statusCode).toBe(422);
    expect(clearDays.json()).toMatchObject({ error: 'price_requires_days' });
  });

  it('treats an expired grant as inactive so its tier can be deleted', async () => {
    const expiredRoleId = await seedRole(h.db, { panelAccess: true });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie: ownerCookie },
      payload: { name: 'VIP Expired', role_id: expiredRoleId },
    });
    const tier = created.json() as { id: string };
    createdTierIds.push(tier.id);

    // Player still carries the role row, but the grant lapsed yesterday.
    await seedPlayer(h.db, expiredRoleId, new Date(Date.now() - 86_400_000));

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vip-tiers/${tier.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
  });
});
