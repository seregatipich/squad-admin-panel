import {
  alertEvents,
  alertRules,
  createDatabaseClient,
  events,
  externalBanSources,
  externalBans,
  moderationActions,
  players,
  servers,
} from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleExternalBanConnect } from '../src/external-ban/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the cban4 test database');

const db = createDatabaseClient(DATABASE_URL);
const SERVER_ID = '00000000-0000-7000-8000-000000000101';
const SOURCE_ID = '00000000-0000-7000-8000-000000000102';
const BAN_ID = '00000000-0000-7000-8000-000000000103';
const PLAYER_STEAM = '76561198100000101';
const PLAYER_NAME = 'ExternalBanStoreTestPlayer';

function makeRedis() {
  const keys = new Set<string>();
  const redis = {
    set: vi.fn(async (key: string) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    }),
    publish: vi.fn(async () => 1),
    xadd: vi.fn(async () => 'stream-id'),
  };
  return redis as unknown as Redis & typeof redis;
}

function connectEvent(): EventEnvelope {
  return {
    event_id: '00000000-0000-7000-8000-000000000104',
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      steam_id64: PLAYER_STEAM,
      eos_id: null,
      name: PLAYER_NAME,
      ip: null,
    },
  };
}

function makeCache(action: 'none' | 'alert' | 'kick', trustLevel = 'trusted') {
  return {
    match: vi.fn().mockResolvedValue([
      {
        externalBanId: BAN_ID,
        sourceId: SOURCE_ID,
        sourceName: 'CBAN4 source',
        trustLevel,
        onMatch: action,
        steamId64: PLAYER_STEAM,
        eosId: null,
        nickname: PLAYER_NAME,
        reason: 'external reason',
      },
    ]),
  };
}

function rconCalls(redis: ReturnType<typeof makeRedis>) {
  return redis.xadd.mock.calls.filter((call) => call[0] === `rcon:commands:${SERVER_ID}`);
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'CBAN4 test server',
    slug: 'cban4-test-server',
  });
  await db.insert(externalBanSources).values({
    id: SOURCE_ID,
    name: 'CBAN4 source',
    url: 'https://example.com/bans.cfg',
    format: 'csv',
    trustLevel: 'trusted',
    onMatch: 'kick',
  });
  await db.insert(externalBans).values({
    id: BAN_ID,
    sourceId: SOURCE_ID,
    steamId64: PLAYER_STEAM,
    reason: 'external reason',
  });
});

afterEach(async () => {
  await db
    .delete(alertEvents)
    .where(eq(alertEvents.ruleId, '00000000-0000-7000-8000-000000000105'));
  await db.delete(alertRules).where(eq(alertRules.id, '00000000-0000-7000-8000-000000000105'));
  await db.delete(moderationActions).where(eq(moderationActions.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.steamId64, BigInt(PLAYER_STEAM)));
});

afterAll(async () => {
  await db.delete(externalBans).where(eq(externalBans.id, BAN_ID));
  await db.delete(externalBanSources).where(eq(externalBanSources.id, SOURCE_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('handleExternalBanConnect', () => {
  it('kicks trusted matches, records history, and never writes a local ban', async () => {
    const redis = makeRedis();
    const cache = makeCache('kick');
    const result = await handleExternalBanConnect(db, redis, cache as never, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });

    expect(result).toMatchObject({ outcome: 'handled', matches: 1, kicked: 1 });
    expect(redis.xadd).toHaveBeenCalledWith(
      `rcon:commands:${SERVER_ID}`,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('AdminKick'),
    );
    const actions = await db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.serverId, SERVER_ID));
    expect(actions[0]).toMatchObject({
      actionType: 'external_ban_kick',
      authorSystemLabel: 'external-ban-worker',
    });
    const matched = await db.select().from(events).where(eq(events.serverId, SERVER_ID));
    expect(matched[0]).toMatchObject({ kind: 'externalban.matched' });
  });

  it('alerts without kicking and honors the BANNAME-style cooldown', async () => {
    await db.insert(alertRules).values({
      id: '00000000-0000-7000-8000-000000000105',
      name: 'CBAN4 alert rule',
      type: 'custom',
      config: { eventKind: 'externalban.matched', severity: 'critical' },
      channels: ['webpush'],
    });
    const redis = makeRedis();
    const cache = makeCache('alert');
    const first = await handleExternalBanConnect(db, redis, cache as never, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });
    const second = await handleExternalBanConnect(db, redis, cache as never, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });

    expect(first).toMatchObject({ outcome: 'handled', alerted: 1, kicked: 0 });
    expect(second).toMatchObject({ outcome: 'cooldown', externalBanId: BAN_ID });
    expect(rconCalls(redis)).toHaveLength(0);
    expect(redis.publish).toHaveBeenCalledWith(
      'live-bus',
      expect.stringContaining('alert.triggered'),
    );
    const rows = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.ruleId, '00000000-0000-7000-8000-000000000105'));
    expect(rows).toHaveLength(1);
  });

  it('fails closed for an invalid kick configuration', async () => {
    const redis = makeRedis();
    const cache = makeCache('kick', 'normal');
    const result = await handleExternalBanConnect(db, redis, cache as never, {
      serverId: SERVER_ID,
      event: connectEvent(),
    });
    expect(result).toMatchObject({ outcome: 'handled', kicked: 0, alerted: 1 });
    expect(rconCalls(redis)).toHaveLength(0);
  });
});
