import {
  players,
  roles,
  vipLifecycleEvents,
  vipTiers,
  whitelistApplications,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import {
  setIsolatedTestVipLifecycleStrict,
  setIsolatedTestWhitelistRole,
  testSteamId,
} from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(998_000);
const PLAYER_A = testSteamId(998_001);
const PLAYER_B = testSteamId(998_002);
const FUTURE_EXPIRY = new Date('2099-09-03T00:00:00.000Z');

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('ограждение внешнего VIP lifecycle от обычных writers', () => {
  let h: IntegrationHarness;
  let cookie: string;
  let sourceRoleId: string;
  let targetRoleId: string;

  async function seedPlayer(steamId64: bigint, roleId: string | null = null): Promise<string> {
    const [player] = await h.db
      .insert(players)
      .values({
        steamId64,
        canonicalName: `VIP fence ${steamId64}`,
        canonicalNameNormalized: `vip fence ${steamId64}`,
        roleId,
      })
      .returning({ id: players.id });
    if (!player) throw new Error('player fixture was not inserted');
    return player.id;
  }

  async function protectPlayer(
    playerId: string,
    steamId64: bigint,
    roleId: string,
  ): Promise<string> {
    const eventId = `vip-fence-${uuidv7()}`;
    await h.db.insert(vipLifecycleEvents).values({
      eventId,
      eventType: 'vip.purchased',
      playerId,
      roleId,
      tier: 'vip2',
      purchaseId: `purchase-${playerId}`,
      action: 'assigned',
      payload: { expires_at: FUTURE_EXPIRY.toISOString() },
      appliedAt: new Date(),
    });
    await h.db
      .update(players)
      .set({
        roleId,
        roleExpiresAt: FUTURE_EXPIRY,
        roleComment: `VIP vip2 purchase purchase-${playerId}`,
        roleLifecycleEventId: eventId,
      })
      .where(and(eq(players.id, playerId), eq(players.steamId64, steamId64)));
    return eventId;
  }

  async function protectStrictVipPlayer(
    playerId: string,
    steamId: bigint,
    roleId: string,
    tierId: string,
  ): Promise<string> {
    const eventId = `vip-fence-strict-${uuidv7()}`;
    const purchaseId = `purchase-${playerId}`;
    await h.db.insert(vipLifecycleEvents).values({
      eventId,
      eventType: 'vip.purchased',
      playerId,
      roleId,
      tier: tierId,
      purchaseId,
      revision: 1,
      requestHash: `hash-${eventId}`,
      action: 'assigned',
      payload: { expires_at: FUTURE_EXPIRY.toISOString() },
      appliedAt: new Date(),
    });
    await h.db
      .update(players)
      .set({
        roleId,
        roleExpiresAt: FUTURE_EXPIRY,
        roleComment: `VIP ${tierId} purchase ${purchaseId}`,
        roleLifecycleEventId: eventId,
      })
      .where(and(eq(players.id, playerId), eq(players.steamId64, steamId)));
    return eventId;
  }

  async function storedRole(playerId: string) {
    const [row] = await h.db
      .select({
        roleId: players.roleId,
        roleExpiresAt: players.roleExpiresAt,
        roleComment: players.roleComment,
        roleLifecycleEventId: players.roleLifecycleEventId,
      })
      .from(players)
      .where(eq(players.id, playerId));
    return row;
  }

  async function expectProtected(playerId: string, eventId: string, roleId = sourceRoleId) {
    expect(await storedRole(playerId)).toEqual({
      roleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP vip2 purchase purchase-${playerId}`,
      roleLifecycleEventId: eventId,
    });
  }

  async function makeVipRole(roleId: string): Promise<string> {
    const tierId = uuidv7();
    await h.db.insert(vipTiers).values({
      id: tierId,
      name: `VIP fence tier ${roleId}`,
      roleId,
      defaultDays: 30,
      isActive: true,
    });
    return tierId;
  }

  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
    cookie = await loginAsOwner(h);
    sourceRoleId = uuidv7();
    targetRoleId = uuidv7();
    await h.db.insert(roles).values([
      { id: sourceRoleId, name: `VIP fence source ${sourceRoleId}`, panelAccess: false },
      { id: targetRoleId, name: `VIP fence target ${targetRoleId}`, panelAccess: false },
    ]);
  });

  afterEach(async () => {
    if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    await h.cleanup();
  });

  it('allows an ordinary VIP-role assignment before the durable cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    await makeVipRole(targetRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${targetRoleId}/members`,
      headers: { cookie },
      payload: { player_id: playerId },
    });

    expect(response.statusCode).toBe(201);
    expect((await storedRole(playerId))?.roleId).toBe(targetRoleId);
  });

  it('rejects an ordinary VIP-role assignment after the durable cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    await makeVipRole(targetRoleId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${targetRoleId}/members`,
      headers: { cookie },
      payload: { player_id: playerId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_required' });
    expect(await storedRole(playerId)).toMatchObject({
      roleId: null,
      roleExpiresAt: null,
      roleComment: null,
      roleLifecycleEventId: null,
    });
  });

  it('rejects a direct clear of a lifecycle-owned projection after cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const eventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    await expect(
      h.db
        .update(players)
        .set({
          roleId: null,
          roleExpiresAt: null,
          roleComment: null,
          roleLifecycleEventId: null,
        })
        .where(and(eq(players.id, playerId), eq(players.steamId64, testSteamId(998_001)))),
    ).rejects.toThrow();

    expect(await storedRole(playerId)).toEqual({
      roleId: sourceRoleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP ${tierId} purchase purchase-${playerId}`,
      roleLifecycleEventId: eventId,
    });
  });

  it('rejects clearing only the role id while retaining a lifecycle marker', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const eventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    await expect(
      h.db
        .update(players)
        .set({ roleId: null })
        .where(and(eq(players.id, playerId), eq(players.steamId64, testSteamId(998_001)))),
    ).rejects.toThrow();

    expect(await storedRole(playerId)).toEqual({
      roleId: sourceRoleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP ${tierId} purchase purchase-${playerId}`,
      roleLifecycleEventId: eventId,
    });
  });

  it('rejects a clear backed only by a lifecycle event committed in an earlier transaction', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const assignedEventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);
    const revokedEventId = `vip-fence-precommitted-revoke-${uuidv7()}`;

    await h.db.insert(vipLifecycleEvents).values({
      eventId: revokedEventId,
      eventType: 'vip.expired',
      playerId,
      roleId: sourceRoleId,
      tier: tierId,
      purchaseId: `purchase-${playerId}`,
      revision: 2,
      requestHash: `hash-${revokedEventId}`,
      action: 'revoked',
      payload: {
        event_id: revokedEventId,
        event_type: 'vip.expired',
        player_id: playerId,
        role_id: sourceRoleId,
        tier: tierId,
        purchase_id: `purchase-${playerId}`,
        revision: 2,
        expires_at: FUTURE_EXPIRY.toISOString(),
      },
      appliedAt: new Date(),
    });

    await expect(
      h.db
        .update(players)
        .set({
          roleId: null,
          roleExpiresAt: null,
          roleComment: null,
          roleLifecycleEventId: null,
        })
        .where(and(eq(players.id, playerId), eq(players.steamId64, testSteamId(998_001)))),
    ).rejects.toThrow();

    expect(await storedRole(playerId)).toEqual({
      roleId: sourceRoleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP ${tierId} purchase purchase-${playerId}`,
      roleLifecycleEventId: assignedEventId,
    });
  });

  it('rejects laundering a precommitted revoke into the current xmin before a clear', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const assignedEventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);
    const revokedEventId = `vip-fence-laundered-revoke-${uuidv7()}`;
    await h.db.insert(vipLifecycleEvents).values({
      eventId: revokedEventId,
      eventType: 'vip.expired',
      playerId,
      roleId: sourceRoleId,
      tier: tierId,
      purchaseId: `purchase-${playerId}`,
      revision: 2,
      requestHash: `hash-${revokedEventId}`,
      action: 'revoked',
      payload: { expires_at: FUTURE_EXPIRY.toISOString() },
      appliedAt: new Date(),
    });

    await expect(
      h.db.transaction(async (tx) => {
        // A no-op UPDATE still gives the old tuple the current transaction's
        // xmin. It must not turn a precommitted event into same-tx proof.
        await tx
          .update(vipLifecycleEvents)
          .set({ action: 'revoked' })
          .where(eq(vipLifecycleEvents.eventId, revokedEventId));
        await tx
          .update(vipLifecycleEvents)
          .set({ supersededByEventId: revokedEventId })
          .where(eq(vipLifecycleEvents.eventId, assignedEventId));
        await tx
          .update(players)
          .set({
            roleId: null,
            roleExpiresAt: null,
            roleComment: null,
            roleLifecycleEventId: null,
          })
          .where(and(eq(players.id, playerId), eq(players.steamId64, PLAYER_A)));
      }),
    ).rejects.toThrow();

    expect(await storedRole(playerId)).toEqual({
      roleId: sourceRoleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP ${tierId} purchase purchase-${playerId}`,
      roleLifecycleEventId: assignedEventId,
    });
  });

  it('rejects direct tampering with the lifecycle event that owns a projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const eventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    await expect(
      h.db
        .update(vipLifecycleEvents)
        .set({ action: 'revoked' })
        .where(eq(vipLifecycleEvents.eventId, eventId)),
    ).rejects.toThrow();

    expect(
      (
        await h.db
          .select({ action: vipLifecycleEvents.action })
          .from(vipLifecycleEvents)
          .where(eq(vipLifecycleEvents.eventId, eventId))
      )[0]?.action,
    ).toBe('assigned');
  });

  it('rejects a direct replacement of a lifecycle-owned projection after cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    const eventId = await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    await expect(
      h.db
        .update(players)
        .set({
          roleId: targetRoleId,
          roleExpiresAt: null,
          roleComment: null,
          roleLifecycleEventId: null,
        })
        .where(and(eq(players.id, playerId), eq(players.steamId64, testSteamId(998_001)))),
    ).rejects.toThrow();

    expect(await storedRole(playerId)).toEqual({
      roleId: sourceRoleId,
      roleExpiresAt: FUTURE_EXPIRY,
      roleComment: `VIP ${tierId} purchase purchase-${playerId}`,
      roleLifecycleEventId: eventId,
    });
  });

  it('returns 409 when an active lifecycle tier is disabled after cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vip-tiers/${tierId}`,
      headers: { cookie },
      payload: { is_active: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    expect(
      (
        await h.db
          .select({ active: vipTiers.isActive })
          .from(vipTiers)
          .where(eq(vipTiers.id, tierId))
      )[0]?.active,
    ).toBe(true);
  });

  it('rejects a late panel tier on the protected site VIP role', async () => {
    const [siteRole] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'QueuePriority'))
      .limit(1);
    expect(siteRole).toBeDefined();
    if (!siteRole) return;

    const siteTierId = uuidv7();
    await h.db.insert(vipTiers).values({
      id: siteTierId,
      name: 'BSS VIP',
      roleId: siteRole.id,
      defaultDays: null,
      priceBonuses: null,
      isActive: true,
    });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vip-tiers',
      headers: { cookie },
      payload: {
        name: `Panel duplicate ${uuidv7()}`,
        role_id: siteRole.id,
        default_days: 30,
        price_bonuses: 100,
        is_active: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'site_vip_binding_protected' });
    expect(
      await h.db
        .select({ id: vipTiers.id })
        .from(vipTiers)
        .where(and(eq(vipTiers.roleId, siteRole.id), eq(vipTiers.isActive, true))),
    ).toEqual([{ id: siteTierId }]);
  });

  it('returns 409 when the protected site VIP role is expanded', async () => {
    const [siteRole] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'QueuePriority'))
      .limit(1);
    expect(siteRole).toBeDefined();
    if (!siteRole) return;

    await h.db.insert(vipTiers).values({
      id: uuidv7(),
      name: 'BSS VIP',
      roleId: siteRole.id,
      defaultDays: null,
      priceBonuses: null,
      isActive: true,
    });

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${siteRole.id}`,
      headers: { cookie },
      payload: { panel_access: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'site_vip_binding_protected' });
    expect(
      (
        await h.db
          .select({ panelAccess: roles.panelAccess })
          .from(roles)
          .where(eq(roles.id, siteRole.id))
      )[0]?.panelAccess,
    ).toBe(false);
  });

  it('returns 409 when a lifecycle role is given panel access after cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${sourceRoleId}`,
      headers: { cookie },
      payload: { panel_access: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    expect(
      (
        await h.db
          .select({ panelAccess: roles.panelAccess })
          .from(roles)
          .where(eq(roles.id, sourceRoleId))
      )[0]?.panelAccess,
    ).toBe(false);
  });

  it('rejects direct deletion of a lifecycle tier after cutover', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const tierId = await makeVipRole(sourceRoleId);
    await protectStrictVipPlayer(playerId, PLAYER_A, sourceRoleId, tierId);
    await setIsolatedTestVipLifecycleStrict(h.db, true);

    await expect(h.db.delete(vipTiers).where(eq(vipTiers.id, tierId))).rejects.toThrow();
    expect(
      await h.db.select({ id: vipTiers.id }).from(vipTiers).where(eq(vipTiers.id, tierId)),
    ).toHaveLength(1);
  });

  it('PUT player role returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${playerId}/role`,
      headers: { cookie },
      payload: { role_id: targetRoleId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('DELETE player role returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${playerId}/role`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('adding a role member returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${targetRoleId}/members`,
      headers: { cookie },
      payload: { player_id: playerId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('removing a role member returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${sourceRoleId}/members/${playerId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('role import is all-or-nothing when one player is lifecycle-owned', async () => {
    const protectedId = await seedPlayer(PLAYER_A);
    const ordinaryId = await seedPlayer(PLAYER_B);
    const eventId = await protectPlayer(protectedId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${targetRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: `${PLAYER_A}\n${PLAYER_B}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(protectedId, eventId);
    expect((await storedRole(ordinaryId))?.roleId).toBeNull();
  });

  it('bulk role removal is all-or-nothing when one player is lifecycle-owned', async () => {
    const protectedId = await seedPlayer(PLAYER_A);
    const ordinaryId = await seedPlayer(PLAYER_B, sourceRoleId);
    const eventId = await protectPlayer(protectedId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${sourceRoleId}/members/bulk-delete`,
      headers: { cookie },
      payload: { player_ids: [protectedId, ordinaryId] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(protectedId, eventId);
    expect((await storedRole(ordinaryId))?.roleId).toBe(sourceRoleId);
  });

  it('bulk role move is all-or-nothing when one player is lifecycle-owned', async () => {
    const protectedId = await seedPlayer(PLAYER_A);
    const ordinaryId = await seedPlayer(PLAYER_B, sourceRoleId);
    const eventId = await protectPlayer(protectedId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${sourceRoleId}/members/move`,
      headers: { cookie },
      payload: { player_ids: [protectedId, ordinaryId], target_role_id: targetRoleId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(protectedId, eventId);
    expect((await storedRole(ordinaryId))?.roleId).toBe(sourceRoleId);
  });

  it('whitelist assignment returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);
    await setIsolatedTestWhitelistRole(h.db, targetRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/members',
      headers: { cookie },
      payload: { player_id: playerId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('whitelist removal returns vip_lifecycle_owned and preserves the projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);
    await setIsolatedTestWhitelistRole(h.db, sourceRoleId);

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/whitelist/members/${playerId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
  });

  it('whitelist import is all-or-nothing when one player is lifecycle-owned', async () => {
    const protectedId = await seedPlayer(PLAYER_A);
    const ordinaryId = await seedPlayer(PLAYER_B);
    const eventId = await protectPlayer(protectedId, PLAYER_A, sourceRoleId);
    await setIsolatedTestWhitelistRole(h.db, targetRoleId);

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/whitelist/import',
      headers: { cookie },
      payload: { csv: `${PLAYER_A}\n${PLAYER_B}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(protectedId, eventId);
    expect((await storedRole(ordinaryId))?.roleId).toBeNull();
  });

  it('application approval returns vip_lifecycle_owned and leaves the application pending', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);
    const [application] = await h.db
      .insert(whitelistApplications)
      .values({
        steamId64: PLAYER_A,
        playerId,
        body: 'VIP fence application',
        requestedRoleId: targetRoleId,
      })
      .returning({ id: whitelistApplications.id });
    if (!application) throw new Error('application fixture was not inserted');

    const response = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/whitelist/applications/${application.id}`,
      headers: { cookie },
      payload: { status: 'approved' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
    const [storedApplication] = await h.db
      .select({ status: whitelistApplications.status })
      .from(whitelistApplications)
      .where(eq(whitelistApplications.id, application.id));
    expect(storedApplication?.status).toBe('pending');
  });

  it('role deletion returns vip_lifecycle_owned and preserves both role and projection', async () => {
    const playerId = await seedPlayer(PLAYER_A);
    const eventId = await protectPlayer(playerId, PLAYER_A, sourceRoleId);

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${sourceRoleId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'vip_lifecycle_owned' });
    await expectProtected(playerId, eventId);
    expect(
      await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, sourceRoleId)),
    ).toHaveLength(1);
  });
});
