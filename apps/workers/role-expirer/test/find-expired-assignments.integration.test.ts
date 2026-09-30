import { randomInt, randomUUID } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  auditLog,
  createDatabaseClient,
  enqueueAdminsCfgSyncForAllServers,
  players,
  roles,
  servers,
  sessions,
  vipSubscriptions,
  vipTiers,
} from '@squad/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearExpiredAssignments,
  createRoleExpiryDeps,
  findExpiredAssignments,
  runRoleExpiryTick,
} from '../src/tick.js';

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

  it('does not clear a role renewed after the expiry scan', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const steamId64 = 76561198914500000n + BigInt(randomInt(1, 1_000_000));
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

      await db
        .update(players)
        .set({ roleExpiresAt: renewedUntil })
        .where(eq(players.steamId64, steamId64));

      const cleared = await clearExpiredAssignments(db, [stale], NOW, {
        reason: 'player.role.expire',
        actor_player_id: null,
        enqueued_at: NOW.toISOString(),
        request_id: 'stale-expiry-test',
      });
      expect(cleared).toEqual({ cleared: [], enqueued: 0, revokedSessionIds: new Map() });
      const [stored] = await db
        .select({ roleId: players.roleId, expiresAt: players.roleExpiresAt })
        .from(players)
        .where(eq(players.steamId64, steamId64));
      expect(stored).toEqual({ roleId: NORMAL_ROLE_ID, expiresAt: renewedUntil });
    } finally {
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

      expect(result).toEqual({
        cleared: [assignment],
        enqueued: activeIds.length,
        revokedSessionIds: new Map(),
      });
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

  it('writes the audit entry and deletes sessions in the same transaction as the role clear (#992)', async () => {
    if (!db) throw new Error('database not configured');
    const playerId = randomUUID();
    const steamId64 = 76561198914650000n + BigInt(randomInt(1, 1_000_000));
    const sessionId = `role-expirer-tx-session-${playerId}`;
    try {
      await db.insert(players).values({
        id: playerId,
        steamId64,
        canonicalName: 'Истёкшая роль с сессией',
        canonicalNameNormalized: 'истёкшая роль с сессией',
        roleId: NORMAL_ROLE_ID,
        roleExpiresAt: EXPIRED_AT,
      });
      await db
        .insert(sessions)
        .values({ id: sessionId, playerId, expiresAt: new Date('2026-08-01T00:00:00.000Z') });

      const [assignment] = await findExpiredAssignments(db, NOW, 1000).then((rows) =>
        rows.filter((row) => row.playerId === playerId),
      );
      if (!assignment) throw new Error('expired assignment was not scanned');

      const result = await clearExpiredAssignments(db, [assignment], NOW, {
        reason: 'player.role.expire',
        actor_player_id: null,
        enqueued_at: NOW.toISOString(),
        request_id: `role-expirer-audit-tx-${randomUUID()}`,
      });

      expect(result.cleared).toEqual([assignment]);
      expect(result.revokedSessionIds.get(playerId)).toEqual([sessionId]);

      const remainingSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.playerId, playerId));
      expect(remainingSessions).toHaveLength(0);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, playerId), eq(auditLog.actionType, 'player.role.expire')));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.beforeSnapshot).toMatchObject({ role_id: NORMAL_ROLE_ID });
      expect(auditRows[0]?.afterSnapshot).toMatchObject({ role_id: null });
    } finally {
      await db.delete(sessions).where(eq(sessions.playerId, playerId));
      await db.delete(players).where(eq(players.steamId64, steamId64));
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

  it('keeps a role that an active subscription is about to renew (regression #989)', async () => {
    if (!db) throw new Error('database not configured');
    const tierId = randomUUID();
    const otherRoleId = randomUUID();
    const steamBase = 76561198914800000n + BigInt(randomInt(1, 100_000)) * 10n;
    const cases = {
      renewing: { steam: steamBase, status: 'active', roleId: NORMAL_ROLE_ID, due: EXPIRED_AT },
      cancelled: {
        steam: steamBase + 1n,
        status: 'cancelled',
        roleId: NORMAL_ROLE_ID,
        due: EXPIRED_AT,
      },
      otherRole: { steam: steamBase + 2n, status: 'active', roleId: otherRoleId, due: EXPIRED_AT },
      renewsMuchLater: {
        steam: steamBase + 3n,
        status: 'active',
        roleId: NORMAL_ROLE_ID,
        due: new Date(EXPIRED_AT.getTime() + 10 * 86_400_000),
      },
    } as const;
    const playerIds = Object.fromEntries(Object.keys(cases).map((key) => [key, randomUUID()]));
    const steams = Object.values(cases).map((c) => c.steam);

    try {
      await db.insert(roles).values({ id: otherRoleId, name: `RoleExpirerSub-${otherRoleId}` });
      await db.insert(vipTiers).values({
        id: tierId,
        name: `RoleExpirerSub ${tierId}`,
        roleId: NORMAL_ROLE_ID,
        defaultDays: 30,
        priceBonuses: 100,
      });
      for (const [key, c] of Object.entries(cases)) {
        await db.insert(players).values({
          id: playerIds[key],
          steamId64: c.steam,
          canonicalName: `Подписчик ${key}`,
          canonicalNameNormalized: `подписчик ${key}`,
          bonusBalance: 500,
          roleId: c.roleId,
          roleExpiresAt: EXPIRED_AT,
        });
        await db.insert(vipSubscriptions).values({
          id: randomUUID(),
          playerId: playerIds[key] as string,
          tierId,
          status: c.status,
          renewsEveryDays: 30,
          priceBonuses: 100,
          nextRenewalAt: c.due,
        });
      }

      const scanned = new Set(
        (await findExpiredAssignments(db, NOW, 1000)).map((row) => row.playerId),
      );
      expect(scanned.has(playerIds.renewing as string)).toBe(false);
      expect(scanned.has(playerIds.cancelled as string)).toBe(true);
      expect(scanned.has(playerIds.otherRole as string)).toBe(true);
      expect(scanned.has(playerIds.renewsMuchLater as string)).toBe(true);

      const notifySessionsRevoked = vi.fn(async () => undefined);
      const realDeps = createRoleExpiryDeps(db, { del: vi.fn(), publish: vi.fn() } as never);
      await runRoleExpiryTick({
        ...realDeps,
        now: NOW,
        findExpiredAssignments: async (now) =>
          (await realDeps.findExpiredAssignments(now)).filter(
            (row) => row.playerId === playerIds.renewing,
          ),
        notifySessionsRevoked,
        diag: { emit: vi.fn(async () => undefined) },
      });
      const [renewing] = await db
        .select({ roleId: players.roleId })
        .from(players)
        .where(eq(players.steamId64, cases.renewing.steam));
      expect(renewing?.roleId).toBe(NORMAL_ROLE_ID);
      expect(notifySessionsRevoked).not.toHaveBeenCalled();
    } finally {
      await db.delete(vipSubscriptions).where(eq(vipSubscriptions.tierId, tierId));
      await db.delete(players).where(inArray(players.steamId64, steams));
      await db.delete(vipTiers).where(eq(vipTiers.id, tierId));
      await db.delete(roles).where(eq(roles.id, otherRoleId));
    }
  });
});
