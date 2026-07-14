import {
  auditLog,
  createDatabaseClient,
  economySettings,
  playerDailyPresence,
  players,
  roles,
  servers,
  sessions,
} from '@squad/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSeedRewardDeps, runSeedRewardTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-14T04:00:00.000Z');
const PLAYER_ID = uuidv7();
const PLAYER_STEAM_ID = 76561198914100001n;
const REWARD_ROLE_ID = uuidv7();
const SERVER_ID = uuidv7();
const SESSION_ID = `seed-reward-${PLAYER_ID}`;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

function makeRedis(): {
  redis: Pick<Redis, 'del' | 'pipeline'>;
  del: ReturnType<typeof vi.fn>;
  xadd: ReturnType<typeof vi.fn>;
} {
  const del = vi.fn(async () => 1);
  const xadd = vi.fn();
  const pipeline = {
    xadd: (...args: unknown[]) => {
      xadd(...args);
      return pipeline;
    },
    exec: vi.fn(async () => []),
  };
  return {
    redis: {
      del,
      pipeline: vi.fn(() => pipeline),
    } as unknown as Pick<Redis, 'del' | 'pipeline'>,
    del,
    xadd,
  };
}

beforeAll(async () => {
  if (!db) return;
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
    .update(economySettings)
    .set({ seedRewardThresholdHoursPerMonth: 0, seedRewardRoleId: null })
    .where(eq(economySettings.id, 1));
  await db.delete(players).where(eq(players.steamId64, PLAYER_STEAM_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(roles).where(eq(roles.id, REWARD_ROLE_ID));
  await db.$client.end();
});

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

    const granted = await runSeedRewardTick({
      ...createSeedRewardDeps(db, firstRedis.redis),
      now: NOW,
      diag,
    });

    expect(granted).toEqual({ skipped: false, granted: 1, revoked: 0, enqueued: 1 });
    const [afterGrant] = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM_ID));
    expect(afterGrant?.roleId).toBe(REWARD_ROLE_ID);
    expect(firstRedis.del).toHaveBeenCalledWith(`session:${SESSION_ID}`);
    expect(firstRedis.xadd).toHaveBeenCalledTimes(1);

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

    const revoked = await runSeedRewardTick({
      ...createSeedRewardDeps(db, secondRedis.redis),
      now: NOW,
      diag,
    });

    expect(revoked).toEqual({ skipped: false, granted: 0, revoked: 1, enqueued: 1 });
    const [afterRevoke] = await db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, PLAYER_STEAM_ID));
    expect(afterRevoke?.roleId).toBeNull();
    expect(secondRedis.del).toHaveBeenCalledWith(`session:${SESSION_ID}-revoke`);

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
});
