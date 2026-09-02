import { randomInt } from 'node:crypto';
import {
  adminsCfgSyncOutbox,
  auditLog,
  createDatabaseClient,
  economySettings,
  playerDailyPresence,
  players,
  roles,
  servers,
  sessions,
} from '@squad/db';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSeedRewardDeps, runSeedRewardTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const NOW = new Date(Date.parse('2026-07-14T00:00:00.000Z') + randomInt(0, 24 * 60 * 60 * 1000));
const OUTBOX_REQUEST_ID = `seed-reward:${NOW.toISOString()}`;
const PLAYER_ID = uuidv7();
// Per run, not a constant: `steam_id64` is unique, so a run whose `afterAll` never
// completed (crash, watch-mode interrupt) would otherwise leave a row that makes
// every later run's `beforeAll` insert fail with 23505 until someone cleans the DB.
const PLAYER_STEAM_ID = 76561198914100000n + BigInt(randomInt(1, 1_000_000));
const OWNER_PLAYER_ID = uuidv7();
const OWNER_PLAYER_STEAM_ID = 76561198914200000n + BigInt(randomInt(1, 1_000_000));
const REWARD_ROLE_ID = uuidv7();
const SERVER_ID = uuidv7();
const SESSION_ID = `seed-reward-${PLAYER_ID}`;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

function makeRedis(): {
  redis: Pick<Redis, 'del' | 'publish'>;
  del: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
} {
  const del = vi.fn(async () => 1);
  const publish = vi.fn(async () => 1);
  return {
    redis: {
      del,
      publish,
    } as unknown as Pick<Redis, 'del' | 'publish'>,
    del,
    publish,
  };
}

function revokedFor(
  publish: ReturnType<typeof vi.fn>,
): Array<{ playerId: string; sessionId: string }> {
  return publish.mock.calls
    .filter(([channel]) => channel === 'live-bus')
    .map(([, raw]) => JSON.parse(raw as string) as { type: string; data: Record<string, string> })
    .filter((evt) => evt.type === 'session.revoked')
    .map((evt) => ({ playerId: evt.data.player_id, sessionId: evt.data.session_id }));
}

beforeAll(async () => {
  if (!db) return;
  await db
    .delete(adminsCfgSyncOutbox)
    .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${OUTBOX_REQUEST_ID}`);
  await db.insert(roles).values({
    id: REWARD_ROLE_ID,
    name: `SeedRewardIntegration_${REWARD_ROLE_ID}`,
    color: '#8B5CF6',
    panelAccess: false,
  });
  await db.insert(players).values({
    id: PLAYER_ID,
    steamId64: PLAYER_STEAM_ID,
    canonicalName: 'Сидер интеграции',
    canonicalNameNormalized: 'сидер интеграции',
  });
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Сервер награды за сид',
    slug: `seed-reward-${SERVER_ID}`,
  });
  await db.insert(playerDailyPresence).values([
    {
      playerId: PLAYER_ID,
      serverId: SERVER_ID,
      day: '2026-06-14',
      seedSeconds: 3600,
      sessionCount: 1,
    },
    {
      playerId: PLAYER_ID,
      serverId: SERVER_ID,
      day: '2026-07-13',
      seedSeconds: 3600,
      sessionCount: 1,
    },
    {
      playerId: PLAYER_ID,
      serverId: SERVER_ID,
      day: '2026-07-14',
      seedSeconds: 3600,
      sessionCount: 1,
    },
  ]);
  await db
    .update(economySettings)
    .set({ seedRewardThresholdHoursPerMonth: 2, seedRewardRoleId: REWARD_ROLE_ID })
    .where(eq(economySettings.id, 1));
});

afterAll(async () => {
  if (!db) return;
  await db
    .delete(adminsCfgSyncOutbox)
    .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${OUTBOX_REQUEST_ID}`);
  await db
    .update(economySettings)
    .set({ seedRewardThresholdHoursPerMonth: 0, seedRewardRoleId: null })
    .where(eq(economySettings.id, 1));
  await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM_ID));
  // OWNER_PLAYER_STEAM_ID is intentionally never deleted: this suite runs
  // against the shared DATABASE_URL used by test:cov's concurrent packages,
  // so whether it is the last remaining Owner at cleanup time depends on
  // that shared state — migration 0107's guard trigger rejects deleting the
  // last Owner. Harmless to leave behind in CI's disposable service container.
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(roles).where(eq(roles.id, REWARD_ROLE_ID));
  await db.$client.end();
});

async function outboxSnapshot(): Promise<Map<string, string>> {
  if (!db) throw new Error('database not configured');
  const rows = await db
    .select({ id: adminsCfgSyncOutbox.id, serverId: adminsCfgSyncOutbox.serverId })
    .from(adminsCfgSyncOutbox)
    .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${OUTBOX_REQUEST_ID}`);
  return new Map(rows.map((row) => [row.id, row.serverId]));
}

/**
 * `reconcileSeedRewardAssignments` scans every player in the database, so the
 * `granted`/`revoked` counts a tick returns cover leftover players from other
 * suites too — asserting a literal 1 tied the test to global DB state exactly
 * like the `enqueued` count did. These two helpers bracket a tick instead: the
 * audit rows written above the watermark are precisely the changes that tick
 * made, which pins the returned counts to a real side effect and lets the test
 * assert its own player's transition exactly, whoever else is in the table.
 */
async function auditWatermark(): Promise<bigint> {
  if (!db) throw new Error('database not configured');
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row?.id ?? 0n;
}

async function seedRewardAuditSince(
  watermark: bigint,
): Promise<Array<{ actionType: string; targetId: string | null }>> {
  if (!db) throw new Error('database not configured');
  return db
    .select({ actionType: auditLog.actionType, targetId: auditLog.targetId })
    .from(auditLog)
    .where(
      and(
        gt(auditLog.id, watermark),
        inArray(auditLog.actionType, ['seed.reward_granted', 'seed.reward_revoked']),
      ),
    )
    .orderBy(asc(auditLog.id));
}

describeIfDb('seed reward worker integration', () => {
  it('grants at the rolling threshold, then revokes below it, with system audits', async () => {
    if (!db) throw new Error('database not configured');
    await db.insert(sessions).values({
      id: SESSION_ID,
      playerId: PLAYER_ID,
      expiresAt: new Date('2026-07-15T04:00:00.000Z'),
    });
    const firstRedis = makeRedis();
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    const grantWatermark = await auditWatermark();
    const grantOutboxBefore = await outboxSnapshot();
    expect(grantOutboxBefore.size).toBe(0);
    const granted = await runSeedRewardTick({
      ...createSeedRewardDeps(db, firstRedis.redis),
      now: NOW,
      diag,
    });

    const grantChanges = await seedRewardAuditSince(grantWatermark);
    const grantTasks = [...(await outboxSnapshot())].filter(([id]) => !grantOutboxBefore.has(id));
    expect(granted).toEqual({
      skipped: false,
      granted: grantChanges.filter((row) => row.actionType === 'seed.reward_granted').length,
      revoked: grantChanges.filter((row) => row.actionType === 'seed.reward_revoked').length,
      enqueued: grantTasks.length,
    });
    expect(grantTasks.map(([, serverId]) => serverId)).toContain(SERVER_ID);
    expect(
      grantChanges.filter((row) => row.targetId === PLAYER_ID).map((row) => row.actionType),
    ).toEqual(['seed.reward_granted']);
    const [afterGrant] = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM_ID));
    expect(afterGrant?.roleId).toBe(REWARD_ROLE_ID);
    expect(firstRedis.del).toHaveBeenCalledWith(`session:${SESSION_ID}`);
    expect(revokedFor(firstRedis.publish)).toContainEqual({
      playerId: PLAYER_ID,
      sessionId: SESSION_ID,
    });

    await db
      .update(playerDailyPresence)
      .set({ seedSeconds: 3599 })
      .where(eq(playerDailyPresence.playerId, PLAYER_ID));
    await db.insert(sessions).values({
      id: `${SESSION_ID}-revoke`,
      playerId: PLAYER_ID,
      expiresAt: new Date('2026-07-15T04:00:00.000Z'),
    });
    const secondRedis = makeRedis();

    const revokeWatermark = await auditWatermark();
    const revokeOutboxBefore = await outboxSnapshot();
    const revoked = await runSeedRewardTick({
      ...createSeedRewardDeps(db, secondRedis.redis),
      now: NOW,
      diag,
    });

    const revokeChanges = await seedRewardAuditSince(revokeWatermark);
    const revokeTasks = [...(await outboxSnapshot())].filter(([id]) => !revokeOutboxBefore.has(id));
    expect(revoked).toEqual({
      skipped: false,
      granted: revokeChanges.filter((row) => row.actionType === 'seed.reward_granted').length,
      revoked: revokeChanges.filter((row) => row.actionType === 'seed.reward_revoked').length,
      enqueued: revokeTasks.length,
    });
    expect(revokeTasks.map(([, serverId]) => serverId)).toContain(SERVER_ID);
    expect(
      revokeChanges.filter((row) => row.targetId === PLAYER_ID).map((row) => row.actionType),
    ).toEqual(['seed.reward_revoked']);
    const [afterRevoke] = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM_ID));
    expect(afterRevoke?.roleId).toBeNull();
    expect(secondRedis.del).toHaveBeenCalledWith(`session:${SESSION_ID}-revoke`);
    expect(revokedFor(secondRedis.publish)).toContainEqual({
      playerId: PLAYER_ID,
      sessionId: `${SESSION_ID}-revoke`,
    });

    const audits = await db
      .select({
        actionType: auditLog.actionType,
        actorKind: auditLog.actorKind,
        actorSystemLabel: auditLog.actorSystemLabel,
        before: auditLog.beforeSnapshot,
        after: auditLog.afterSnapshot,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, PLAYER_ID),
          inArray(auditLog.actionType, ['seed.reward_granted', 'seed.reward_revoked']),
        ),
      )
      .orderBy(asc(auditLog.id));
    expect(audits).toEqual([
      expect.objectContaining({
        actionType: 'seed.reward_granted',
        actorKind: 'system',
        actorSystemLabel: 'seed-reward',
        before: expect.objectContaining({ role_id: null }),
        after: expect.objectContaining({ role_id: REWARD_ROLE_ID }),
      }),
      expect.objectContaining({
        actionType: 'seed.reward_revoked',
        actorKind: 'system',
        actorSystemLabel: 'seed-reward',
        before: expect.objectContaining({ role_id: REWARD_ROLE_ID }),
        after: expect.objectContaining({ role_id: null }),
      }),
    ]);
  });

  it('never reassigns a player who currently holds the Owner role, even if they qualify', async () => {
    if (!db) throw new Error('database not configured');
    const [ownerRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    if (!ownerRole) throw new Error('Owner role not found — run migrations first');

    await db.insert(players).values({
      id: OWNER_PLAYER_ID,
      steamId64: OWNER_PLAYER_STEAM_ID,
      canonicalName: 'Владелец на сиде',
      canonicalNameNormalized: 'владелец на сиде',
      roleId: ownerRole.id,
    });
    await db.insert(playerDailyPresence).values({
      playerId: OWNER_PLAYER_ID,
      serverId: SERVER_ID,
      day: '2026-07-14',
      seedSeconds: 3 * 3600,
      sessionCount: 1,
    });

    const watermark = await auditWatermark();
    const { redis } = makeRedis();
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };

    await runSeedRewardTick({ ...createSeedRewardDeps(db, redis), now: NOW, diag });

    const changes = await seedRewardAuditSince(watermark);
    expect(changes.filter((row) => row.targetId === OWNER_PLAYER_ID)).toEqual([]);
    const [afterTick] = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.id, OWNER_PLAYER_ID));
    expect(afterTick?.roleId).toBe(ownerRole.id);
  });
});
