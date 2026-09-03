import { randomInt, randomUUID } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  createDatabaseClient,
  enqueueAdminsCfgSyncForAllServers,
  players,
  roles,
  servers,
  vipLifecycleEvents,
} from '@squad/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearExpiredAssignments, findExpiredAssignments } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const NORMAL_ROLE_ID = randomUUID();
const NORMAL_PLAYER_ID = randomUUID();
const NORMAL_PLAYER_STEAM_ID = 76561198914300000n + BigInt(randomInt(1, 1_000_000));
const OWNER_PLAYER_ID = randomUUID();
const OWNER_PLAYER_STEAM_ID = 76561198914400000n + BigInt(randomInt(1, 1_000_000));

const EXPIRED_AT = new Date('2026-07-06T09:59:00.000Z');
const NOW = new Date('2026-07-06T10:00:00.000Z');

beforeAll(async () => {
  if (!db) return;
  const [ownerRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role not found — run migrations first');

  await db.insert(roles).values({ id: NORMAL_ROLE_ID, name: `RoleExpirerFind-${NORMAL_ROLE_ID}` });
  await db.insert(players).values([
    {
      id: NORMAL_PLAYER_ID,
      steamId64: NORMAL_PLAYER_STEAM_ID,
      canonicalName: 'Истекший модератор',
      canonicalNameNormalized: 'истекший модератор',
      roleId: NORMAL_ROLE_ID,
      roleExpiresAt: EXPIRED_AT,
    },
    {
      id: OWNER_PLAYER_ID,
      steamId64: OWNER_PLAYER_STEAM_ID,
      canonicalName: 'Истекший владелец',
      canonicalNameNormalized: 'истекший владелец',
      roleId: ownerRole.id,
      roleExpiresAt: EXPIRED_AT,
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(players).where(eq(players.steamId64, NORMAL_PLAYER_STEAM_ID));
  // OWNER_PLAYER_STEAM_ID is intentionally never deleted: this suite runs
  // against the shared DATABASE_URL used by test:cov's concurrent packages,
  // so whether it is the last remaining Owner at cleanup time depends on
  // that shared state — migration 0107's guard trigger rejects deleting the
  // last Owner. Harmless to leave behind in CI's disposable service container.
  await db.delete(roles).where(eq(roles.id, NORMAL_ROLE_ID));
  await db.$client.end();
});

describeIfDb('findExpiredAssignments against a real database', () => {
  it('never treats an expired Owner role assignment as eligible for expiry', async () => {
    if (!db) throw new Error('database not configured');
    const expired = await findExpiredAssignments(db, NOW, 1000);
    const byPlayerId = new Map(expired.map((row) => [row.playerId, row]));

    expect(byPlayerId.has(NORMAL_PLAYER_ID)).toBe(true);
    expect(byPlayerId.has(OWNER_PLAYER_ID)).toBe(false);
  });

  it('does not clear a lifecycle role renewed after the expiry scan', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const steamId64 = 76561198914500000n + BigInt(randomInt(1, 1_000_000));
    const eventId = `role-expirer-renewal-${randomUUID()}`;
    const renewedUntil = new Date('2030-07-06T10:00:00.000Z');

    try {
      await db.insert(players).values({
        id: playerId,
        steamId64,
        canonicalName: 'Продлённый VIP',
        canonicalNameNormalized: 'продлённый vip',
        roleId: NORMAL_ROLE_ID,
        roleExpiresAt: EXPIRED_AT,
      });
      const scanned = await findExpiredAssignments(db, NOW, 1000);
      const stale = scanned.find((assignment) => assignment.playerId === playerId);
      expect(stale).toBeDefined();
      if (!stale) throw new Error('expired assignment was not scanned');

      await db.insert(vipLifecycleEvents).values({
        eventId,
        eventType: 'vip.extended',
        playerId,
        roleId: NORMAL_ROLE_ID,
        tier: 'tier_1',
        purchaseId: 'purchase-B',
        action: 'assigned',
        payload: { expires_at: renewedUntil.toISOString() },
        appliedAt: NOW,
      });
      await db
        .update(players)
        .set({ roleExpiresAt: renewedUntil, roleLifecycleEventId: eventId })
        .where(eq(players.steamId64, steamId64));

      const cleared = await clearExpiredAssignments(db, [stale], NOW, {
        reason: 'player.role.expire',
        actor_player_id: null,
        enqueued_at: NOW.toISOString(),
        request_id: 'stale-expiry-test',
      });
      expect(cleared).toEqual({ cleared: [], enqueued: 0 });
      const [stored] = await db
        .select({ roleId: players.roleId, expiresAt: players.roleExpiresAt })
        .from(players)
        .where(eq(players.steamId64, steamId64));
      expect(stored).toEqual({ roleId: NORMAL_ROLE_ID, expiresAt: renewedUntil });
    } finally {
      await db.delete(vipLifecycleEvents).where(eq(vipLifecycleEvents.eventId, eventId));
      await db.delete(players).where(eq(players.steamId64, steamId64));
    }
  });

  it('leaves an expired lifecycle-owned projection to the signed lifecycle writer', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const steamId64 = 76561198914800000n + BigInt(randomInt(1, 1_000_000));
    const eventId = `role-expirer-owned-${randomUUID()}`;
    const assignment = {
      playerId,
      roleId: NORMAL_ROLE_ID,
      roleExpiresAt: EXPIRED_AT,
      roleComment: 'VIP tier_1 purchase purchase-owned',
      roleLifecycleEventId: eventId,
    };

    try {
      await db.insert(players).values({
        id: playerId,
        steamId64,
        canonicalName: 'Истёкший внешний VIP',
        canonicalNameNormalized: 'истёкший внешний vip',
      });
      await db.insert(vipLifecycleEvents).values({
        eventId,
        eventType: 'vip.purchased',
        playerId,
        roleId: NORMAL_ROLE_ID,
        tier: 'tier_1',
        purchaseId: 'purchase-owned',
        action: 'assigned',
        payload: { expires_at: EXPIRED_AT.toISOString() },
        appliedAt: NOW,
      });
      await db
        .update(players)
        .set({
          roleId: NORMAL_ROLE_ID,
          roleExpiresAt: EXPIRED_AT,
          roleComment: assignment.roleComment,
          roleLifecycleEventId: eventId,
        })
        .where(eq(players.id, playerId));

      expect(
        (await findExpiredAssignments(db, NOW, 1000)).map((row) => row.playerId),
      ).not.toContain(playerId);
      expect(
        await clearExpiredAssignments(db, [assignment], NOW, {
          reason: 'player.role.expire',
          actor_player_id: null,
          enqueued_at: NOW.toISOString(),
          request_id: 'owned-expiry-test',
        }),
      ).toEqual({ cleared: [], enqueued: 0 });
      const [stored] = await db
        .select({ roleId: players.roleId, marker: players.roleLifecycleEventId })
        .from(players)
        .where(eq(players.id, playerId));
      expect(stored).toEqual({ roleId: NORMAL_ROLE_ID, marker: eventId });
    } finally {
      await db.delete(vipLifecycleEvents).where(eq(vipLifecycleEvents.eventId, eventId));
      await db.delete(players).where(eq(players.steamId64, steamId64));
    }
  });

  it('commits role expiry with one outbox row per active server', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const serverId = randomUUID();
    const steamId64 = 76561198914600000n + BigInt(randomInt(1, 1_000_000));
    const requestId = `role-expirer-success-${randomUUID()}`;
    try {
      await db
        .delete(adminsCfgSyncOutbox)
        .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${requestId}`);
      await db.insert(players).values({
        id: playerId,
        steamId64,
        canonicalName: 'Истёкшая роль с outbox',
        canonicalNameNormalized: 'истёкшая роль с outbox',
        roleId: NORMAL_ROLE_ID,
        roleExpiresAt: EXPIRED_AT,
      });
      await db.insert(servers).values({
        id: serverId,
        displayName: 'Role expiry outbox server',
        slug: `role-expiry-outbox-${serverId}`,
      });
      const [assignment] = await findExpiredAssignments(db, NOW, 1000).then((rows) =>
        rows.filter((row) => row.playerId === playerId),
      );
      if (!assignment) throw new Error('expired assignment was not scanned');
      const activeIds = (
        await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt))
      ).map((row) => row.id);

      const result = await clearExpiredAssignments(db, [assignment], NOW, {
        reason: 'player.role.expire',
        actor_player_id: null,
        enqueued_at: NOW.toISOString(),
        request_id: requestId,
      });

      expect(result).toEqual({ cleared: [assignment], enqueued: activeIds.length });
      const rows = await db
        .select({ serverId: adminsCfgSyncOutbox.serverId })
        .from(adminsCfgSyncOutbox)
        .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${requestId}`);
      expect(new Set(rows.map((row) => row.serverId))).toEqual(new Set(activeIds));
    } finally {
      await db
        .delete(adminsCfgSyncOutbox)
        .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${requestId}`);
      await db.delete(players).where(eq(players.steamId64, steamId64));
      await db.delete(servers).where(eq(servers.id, serverId));
    }
  });

  it('rolls a role mutation back when its transactional outbox insert fails', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const steamId64 = 76561198914700000n + BigInt(randomInt(1, 1_000_000));
    try {
      await db.insert(players).values({
        id: playerId,
        steamId64,
        canonicalName: 'Откат роли при ошибке outbox',
        canonicalNameNormalized: 'откат роли при ошибке outbox',
        roleId: NORMAL_ROLE_ID,
        roleExpiresAt: EXPIRED_AT,
      });

      await expect(
        db.transaction(async (tx) => {
          await tx
            .update(players)
            .set({ roleId: null, roleExpiresAt: null })
            .where(eq(players.id, playerId));
          await enqueueAdminsCfgSyncForAllServers(tx, { reason: 'rollback-proof' }, [randomUUID()]);
        }),
      ).rejects.toThrow();

      const [stored] = await db
        .select({ roleId: players.roleId, roleExpiresAt: players.roleExpiresAt })
        .from(players)
        .where(eq(players.id, playerId));
      expect(stored).toEqual({ roleId: NORMAL_ROLE_ID, roleExpiresAt: EXPIRED_AT });
    } finally {
      await db.delete(players).where(eq(players.steamId64, steamId64));
    }
  });
});
