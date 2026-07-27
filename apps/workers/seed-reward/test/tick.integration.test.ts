import { randomInt } from 'node:crypto';
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
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSeedRewardDeps, runSeedRewardTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-07-14T04:00:00.000Z');
const PLAYER_ID = uuidv7();
// Per run, not a constant: `steam_id64` is unique, so a run whose `afterAll` never
// completed (crash, watch-mode interrupt) would otherwise leave a row that makes
// every later run's `beforeAll` insert fail with 23505 until someone cleans the DB.
const PLAYER_STEAM_ID = 76561198914100000n + BigInt(randomInt(1, 1_000_000));
const REWARD_ROLE_ID = uuidv7();
const SERVER_ID = uuidv7();
const SESSION_ID = `seed-reward-${PLAYER_ID}`;

const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

function makeRedis(): {
  redis: Pick<Redis, 'del' | 'pipeline' | 'publish'>;
  del: ReturnType<typeof vi.fn>;
  xadd: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
} {
  const del = vi.fn(async () => 1);
  const xadd = vi.fn();
  const publish = vi.fn(async () => 1);
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
      publish,
    } as unknown as Pick<Redis, 'del' | 'pipeline' | 'publish'>,
    del,
    xadd,
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

/**
 * `publishAdminsCfgSyncForAllServers` enqueues one outbox row per *active server
 * in the database*, not per server this test created, so a literal 1 tied the
 * expectation to global DB state. Re-counting the servers afterwards fixed the
 * ordering dependency but not a concurrency one: the affected-package sweep runs
 * every package against one shared DATABASE_URL, and suites that create and drop
 * servers (log-ingest's, for instance) move the count between the tick and the
 * re-count — observed as `expected "spy" to be called 5 times, but got 6 times`.
 *
 * Read the fan-out off the tick itself instead. The streams it published are the
 * servers it saw, so `enqueued` is checked against the side effect it reports on
 * with no second look at the table, and this test's own server is still asserted
 * exactly.
 */
function syncedStreams(xadd: ReturnType<typeof vi.fn>): string[] {
  return xadd.mock.calls.map(([stream]) => stream as string);
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
    const granted = await runSeedRewardTick({
      ...createSeedRewardDeps(db, firstRedis.redis),
      now: NOW,
      diag,
    });

    const grantChanges = await seedRewardAuditSince(grantWatermark);
    const grantStreams = syncedStreams(firstRedis.xadd);
    expect(granted).toEqual({
      skipped: false,
      granted: grantChanges.filter((row) => row.actionType === 'seed.reward_granted').length,
      revoked: grantChanges.filter((row) => row.actionType === 'seed.reward_revoked').length,
      enqueued: grantStreams.length,
    });
    expect(grantStreams).toContain(`events:admins-cfg-sync:${SERVER_ID}`);
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
    const revoked = await runSeedRewardTick({
      ...createSeedRewardDeps(db, secondRedis.redis),
      now: NOW,
      diag,
    });

    const revokeChanges = await seedRewardAuditSince(revokeWatermark);
    const revokeStreams = syncedStreams(secondRedis.xadd);
    expect(revoked).toEqual({
      skipped: false,
      granted: revokeChanges.filter((row) => row.actionType === 'seed.reward_granted').length,
      revoked: revokeChanges.filter((row) => row.actionType === 'seed.reward_revoked').length,
      enqueued: revokeStreams.length,
    });
    expect(revokeStreams).toContain(`events:admins-cfg-sync:${SERVER_ID}`);
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
});
