import {
  alertEvents,
  alertRules,
  createDatabaseClient,
  events,
  moderationActions,
  playerLinks,
  players,
  processedEvents,
  servers,
} from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAltBanConnect } from '../src/alt-ban/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the ALT-7 test database');

const db = createDatabaseClient(DATABASE_URL);
const SERVER_ID = '00000000-0000-7000-8000-000000000125';
const RULE_ID = '00000000-0000-7000-8000-000000001125';
const BANNED_STEAM = 76561198125000001n;
const CONNECTING_STEAM = 76561198125000002n;

let bannedPlayerId: string;
let connectingPlayerId: string;

function makeRedis() {
  const redis = {
    publish: vi.fn(async () => 1),
    set: vi.fn(async () => 'OK'),
    xadd: vi.fn(async () => 'stream-id'),
  };
  return redis as unknown as Redis & typeof redis;
}

function connectEvent(): EventEnvelope {
  return {
    event_id: uuidv7(),
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      steam_id64: CONNECTING_STEAM.toString(),
      eos_id: null,
      name: 'ALT-7 connecting alt',
      ip: null,
    },
  };
}

async function seedRule(enabled = true): Promise<void> {
  await db.insert(alertRules).values({
    id: RULE_ID,
    name: 'ALT-7 ban evasion',
    type: 'custom',
    config: { eventKind: 'alt.ban_evasion_suspected', severity: 'critical' },
    channels: ['webpush'],
    enabled,
  });
}

async function seedLink(status: 'confirmed' | 'rejected'): Promise<void> {
  const [playerAId, playerBId] = [bannedPlayerId, connectingPlayerId].sort();
  await db.insert(playerLinks).values({
    playerAId,
    playerBId,
    linkType: 'alt',
    status,
  });
}

async function seedBan(revertedAt: Date | null = null): Promise<void> {
  await db.insert(moderationActions).values({
    playerId: bannedPlayerId,
    actionType: 'ban',
    authorSystemLabel: 'alt-ban-test',
    reason: 'ALT-7 active ban',
    revertedAt,
  });
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'ALT-7 connect test server',
    slug: 'alt-7-connect-test',
  });
});

beforeEach(async () => {
  const inserted = await db
    .insert(players)
    .values([
      {
        id: uuidv7(),
        steamId64: BANNED_STEAM,
        canonicalName: 'ALT-7 banned player',
        canonicalNameNormalized: 'alt-7 banned player',
      },
      {
        id: uuidv7(),
        steamId64: CONNECTING_STEAM,
        canonicalName: 'ALT-7 connecting alt',
        canonicalNameNormalized: 'alt-7 connecting alt',
      },
    ])
    .returning({ id: players.id, steamId64: players.steamId64 });
  const banned = inserted.find((player) => player.steamId64 === BANNED_STEAM);
  const connecting = inserted.find((player) => player.steamId64 === CONNECTING_STEAM);
  if (!banned || !connecting) throw new Error('failed to seed ALT-7 players');
  bannedPlayerId = banned.id;
  connectingPlayerId = connecting.id;
});

afterEach(async () => {
  const signalEvents = await db
    .select({ eventId: events.eventId })
    .from(events)
    .where(eq(events.serverId, SERVER_ID));
  if (signalEvents.length > 0) {
    const eventIds = signalEvents.map((event) => event.eventId);
    await db.delete(processedEvents).where(inArray(processedEvents.eventId, eventIds));
  }
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(alertRules).where(eq(alertRules.id, RULE_ID));
  await db.delete(players).where(inArray(players.steamId64, [BANNED_STEAM, CONNECTING_STEAM]));
});

afterAll(async () => {
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('handleAltBanConnect', () => {
  it('raises a domain event and gated alert when a confirmed alt of an actively banned player connects', async () => {
    await seedRule();
    await seedLink('confirmed');
    await seedBan();
    const redis = makeRedis();

    const result = await handleAltBanConnect(db, redis, connectEvent());

    expect(result).toMatchObject({
      outcome: 'detected',
      connectingPlayerId,
      bannedPlayerIds: [bannedPlayerId],
      alertsRaised: 1,
    });
    const signalEvents = await db.select().from(events).where(eq(events.serverId, SERVER_ID));
    expect(signalEvents).toHaveLength(1);
    expect(signalEvents[0]).toMatchObject({ kind: 'alt.ban_evasion_suspected' });
    expect(signalEvents[0]?.payload).toMatchObject({
      target_player_id: connectingPlayerId,
      confirmed_alt_ids: [bannedPlayerId],
      candidate_ids: [],
      trigger: 'player_connected',
      server_id: SERVER_ID,
    });
    const alerts = await db.select().from(alertEvents).where(eq(alertEvents.ruleId, RULE_ID));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect(alerts[0]?.payload).toMatchObject({
      target_player_id: connectingPlayerId,
      confirmed_alt_ids: [bannedPlayerId],
      trigger: 'player_connected',
    });
    expect(redis.publish).toHaveBeenCalledWith(
      'live-bus',
      expect.stringContaining('alert.triggered'),
    );
  });

  it('does not raise the signal when the linked account has no active ban', async () => {
    await seedRule();
    await seedLink('confirmed');
    await seedBan(new Date());

    const result = await handleAltBanConnect(db, makeRedis(), connectEvent());

    expect(result).toMatchObject({ outcome: 'no_active_ban', connectingPlayerId });
    expect(await db.select().from(events).where(eq(events.serverId, SERVER_ID))).toHaveLength(0);
    expect(await db.select().from(alertEvents).where(eq(alertEvents.ruleId, RULE_ID))).toHaveLength(
      0,
    );
  });

  it('does not raise the signal for a link that is not confirmed', async () => {
    await seedRule();
    await seedLink('rejected');
    await seedBan();

    const result = await handleAltBanConnect(db, makeRedis(), connectEvent());

    expect(result).toMatchObject({ outcome: 'no_confirmed_alt', connectingPlayerId });
    expect(await db.select().from(events).where(eq(events.serverId, SERVER_ID))).toHaveLength(0);
    expect(await db.select().from(alertEvents).where(eq(alertEvents.ruleId, RULE_ID))).toHaveLength(
      0,
    );
  });

  it('persists the signal but honors a disabled AUTO-3 alert rule', async () => {
    await seedRule(false);
    await seedLink('confirmed');
    await seedBan();

    const result = await handleAltBanConnect(db, makeRedis(), connectEvent());

    expect(result).toMatchObject({ outcome: 'detected', alertsRaised: 0 });
    expect(await db.select().from(events).where(eq(events.serverId, SERVER_ID))).toHaveLength(1);
    expect(await db.select().from(alertEvents).where(eq(alertEvents.ruleId, RULE_ID))).toHaveLength(
      0,
    );
  });
});
