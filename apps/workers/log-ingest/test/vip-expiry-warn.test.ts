import { createDatabaseClient, economySettings, expiryNotifications, players } from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { handleVipExpiryWarnConnect } from '../src/vip-expiry/warn.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the vip-expiry test database');

const db = createDatabaseClient(DATABASE_URL);
const SERVER_ID = '00000000-0000-7000-8000-000000000171';
const ROLE_ID = '00000000-0000-7000-8000-000000000172';
const PLAYER_STEAM = '76561198100001701';
const PLAYER_EOS = 'abcdef0123456789abcdef0123456701';
const PLAYER_NAME = 'VipExpiryWarnTestPlayer';

function makeRedis() {
  const redis = { xadd: vi.fn(async () => 'stream-id') };
  return redis;
}

function connectEvent(overrides: { eos_id?: string | null } = {}): EventEnvelope {
  return {
    event_id: '00000000-0000-7000-8000-000000000173',
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      steam_id64: PLAYER_STEAM,
      eos_id: overrides.eos_id !== undefined ? overrides.eos_id : null,
      name: PLAYER_NAME,
      ip: null,
    },
  };
}

async function seedPlayerWithPendingWarn(windowDays = 3): Promise<string> {
  const expiresAt = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000 - 60_000);
  const [player] = await db
    .insert(players)
    .values({
      steamId64: BigInt(PLAYER_STEAM),
      canonicalName: PLAYER_NAME,
      canonicalNameNormalized: PLAYER_NAME.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!player) throw new Error('player insert failed');
  await db.insert(expiryNotifications).values({
    playerId: player.id,
    roleId: ROLE_ID,
    expiresAt,
    windowDays,
    recipient: 'player',
  });
  return player.id;
}

async function pendingRows(playerId: string) {
  return db
    .select({
      queuedAt: expiryNotifications.queuedAt,
      windowDays: expiryNotifications.windowDays,
    })
    .from(expiryNotifications)
    .where(eq(expiryNotifications.playerId, playerId));
}

afterEach(async () => {
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, BigInt(PLAYER_STEAM)));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(expiryNotifications).where(inArray(expiryNotifications.playerId, ids));
  }
  await db.delete(players).where(eq(players.steamId64, BigInt(PLAYER_STEAM)));
});

afterAll(async () => {
  await db.$client.end();
});

describe('handleVipExpiryWarnConnect', () => {
  it('enqueues AdminWarn once on connect and stamps queued_at', async () => {
    const playerId = await seedPlayerWithPendingWarn(3);
    const redis = makeRedis();

    const result = await handleVipExpiryWarnConnect(db, redis, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });

    expect(result).toMatchObject({ outcome: 'warned', windowDays: 3 });
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(redis.xadd).toHaveBeenCalledWith(
      `rcon:commands:${SERVER_ID}`,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('VIP истекает через 3 дн.'),
    );
    const rows = await pendingRows(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queuedAt).not.toBeNull();
  });

  it('second connect does not re-warn', async () => {
    await seedPlayerWithPendingWarn(3);
    const redis = makeRedis();

    await handleVipExpiryWarnConnect(db, redis, { serverId: SERVER_ID, event: connectEvent() });
    const second = await handleVipExpiryWarnConnect(db, redis, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });

    expect(second).toEqual({ outcome: 'no_pending' });
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('targets eos_id when present, steam_id64 otherwise', async () => {
    await seedPlayerWithPendingWarn(1);
    const redis = makeRedis();
    await handleVipExpiryWarnConnect(db, redis, {
      serverId: SERVER_ID,
      event: connectEvent({ eos_id: PLAYER_EOS }),
    });
    expect(redis.xadd).toHaveBeenCalledWith(
      `rcon:commands:${SERVER_ID}`,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining(PLAYER_EOS),
    );

    // Reset the queue and warn again without an EOS id: falls back to SteamID64.
    await db
      .update(expiryNotifications)
      .set({ queuedAt: null })
      .where(eq(expiryNotifications.roleId, ROLE_ID));
    const redis2 = makeRedis();
    await handleVipExpiryWarnConnect(db, redis2, { serverId: SERVER_ID, event: connectEvent() });
    expect(redis2.xadd).toHaveBeenCalledWith(
      `rcon:commands:${SERVER_ID}`,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining(PLAYER_STEAM),
    );
  });

  it('respects vip_expiry_warn_in_game=false', async () => {
    const playerId = await seedPlayerWithPendingWarn(3);
    const redis = makeRedis();
    await db
      .insert(economySettings)
      .values({ id: 1, vipExpiryWarnInGame: false })
      .onConflictDoUpdate({ target: economySettings.id, set: { vipExpiryWarnInGame: false } });
    try {
      const result = await handleVipExpiryWarnConnect(db, redis, {
        serverId: SERVER_ID,
        event: connectEvent(),
      });

      expect(result).toMatchObject({ outcome: 'warn_disabled' });
      expect(redis.xadd).not.toHaveBeenCalled();
      // The row is still stamped so the warn does not stay pending forever.
      const rows = await pendingRows(playerId);
      expect(rows[0]?.queuedAt).not.toBeNull();
    } finally {
      await db
        .update(economySettings)
        .set({ vipExpiryWarnInGame: true })
        .where(eq(economySettings.id, 1));
    }
  });
});
