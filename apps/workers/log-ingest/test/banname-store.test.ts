import {
  bannedNameRules,
  createDatabaseClient,
  events,
  moderationActions,
  players,
  servers,
} from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { rconCommandRequestSchema } from '@squad/shared-types';
import { and, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BannedNameRuleCache } from '../src/banname/rules-cache.js';
import { buildBannedNameKickMessage, handleBannedNameEvent } from '../src/banname/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the banname104 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const KICK_RULE_ID = uuidv7();
const ALERT_RULE_ID = uuidv7();
const RENAME_RULE_ID = uuidv7();

function makeRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, String(value));
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const next = (Number(store.get(key)) || 0) + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    xadd: vi.fn(async () => 'stream-id'),
    /** Test-only: simulates the 60s cooldown TTL elapsing without touching the escalation counter. */
    __clearCooldowns: () => {
      for (const key of [...store.keys()]) {
        if (key.startsWith('banname:cooldown:')) store.delete(key);
      }
    },
  };
  return redis as unknown as Redis & typeof redis;
}

function connectEvent(
  overrides: { name?: string; eosId?: string | null; steamId64?: string } = {},
): EventEnvelope {
  return {
    event_id: uuidv7(),
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: {
      name: overrides.name ?? 'ProCheaterOne',
      eos_id: overrides.eosId === undefined ? 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' : overrides.eosId,
      steam_id64: overrides.steamId64 ?? '76561198990000001',
      ip: null,
    },
  };
}

function nameChangedEvent(
  overrides: { name?: string; eosId?: string | null; steamId64?: string } = {},
): EventEnvelope {
  return {
    ...connectEvent(overrides),
    type: 'player.name_changed',
    payload: {
      name: overrides.name ?? 'X',
      eos_id: overrides.eosId === undefined ? 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' : overrides.eosId,
      steam_id64: overrides.steamId64 ?? '76561198990000004',
    },
  };
}

/**
 * `handleBannedNameEvent` also XADDs the `banname.matched` event onto the
 * server's event stream (via publish.ts); these helpers isolate assertions
 * to the RCON command stream specifically, ignoring that unrelated XADD.
 */
function rconXaddCalls(redis: ReturnType<typeof makeRedis>): unknown[][] {
  return redis.xadd.mock.calls.filter((call) => call[0] === `rcon:commands:${SERVER_ID}`);
}

const TEST_PLAYER_NAMES_NORMALIZED = ['procheaterone', 'suspectplayer', 'x'];

async function cleanupPlayers(): Promise<void> {
  // audit_log is append-only (DB trigger denies deletes); the player.created
  // rows it accumulates here are harmless residue in an isolated test DB.
  await db
    .delete(players)
    .where(inArray(players.canonicalNameNormalized, TEST_PLAYER_NAMES_NORMALIZED));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Banname Test Server',
    slug: `banname-test-${SERVER_ID.slice(0, 8)}`,
  });
});

beforeEach(async () => {
  await db.insert(bannedNameRules).values([
    {
      id: KICK_RULE_ID,
      pattern: 'cheater',
      matchType: 'substring',
      action: 'kick',
      reason: 'читер в нике',
      isActive: true,
    },
    {
      id: ALERT_RULE_ID,
      pattern: 'suspect',
      matchType: 'substring',
      action: 'alert',
      reason: 'подозрительный ник',
      isActive: true,
    },
    {
      id: RENAME_RULE_ID,
      pattern: 'X',
      matchType: 'exact',
      action: 'kick',
      reason: 'запрещённый ник после смены',
      isActive: true,
    },
  ]);
});

afterEach(async () => {
  await db.delete(moderationActions).where(eq(moderationActions.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await cleanupPlayers();
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, KICK_RULE_ID));
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, ALERT_RULE_ID));
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, RENAME_RULE_ID));
});

afterAll(async () => {
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('buildBannedNameKickMessage', () => {
  it('includes the rule reason in both Russian and English', () => {
    const message = buildBannedNameKickMessage('читер в нике');
    expect(message).toContain('читер в нике');
    expect(message.toLowerCase()).toContain('kicked');
  });

  it('omits the parenthetical when there is no reason', () => {
    const message = buildBannedNameKickMessage(null);
    expect(message).not.toContain('()');
  });

  it('strips newlines and caps length so it stays RCON-safe', () => {
    const message = buildBannedNameKickMessage(`bad\r\nreason${'x'.repeat(400)}`);
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBeLessThanOrEqual(280);
  });
});

describe('handleBannedNameEvent', () => {
  it('is a no-op for events other than player.connected or player.name_changed', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const event: EventEnvelope = {
      event_id: uuidv7(),
      version: 1,
      type: 'player.disconnected',
      server_id: SERVER_ID,
      ts: new Date().toISOString(),
      actor: null,
      correlation_id: null,
      payload: { steam_id64: '76561198990000001', eos_id: null, reason: null },
    };
    const result = await handleBannedNameEvent(db, redis, { serverId: SERVER_ID, event }, cache);
    expect(result).toEqual({ outcome: 'ignored' });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns no_match for a nickname matching no active rule', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent({ name: 'TotallyFineName' }) },
      cache,
    );
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('rechecks a clean player when player.name_changed matches an enabled rule', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const identity = {
      eosId: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
      steamId64: '76561198990000004',
    };

    const cleanConnect = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent({ ...identity, name: 'Clean' }) },
      cache,
    );
    expect(cleanConnect).toEqual({ outcome: 'no_match' });
    expect(rconXaddCalls(redis)).toHaveLength(0);

    const renamed = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: nameChangedEvent({ ...identity, name: 'X' }) },
      cache,
    );

    expect(renamed).toMatchObject({
      outcome: 'handled',
      ruleId: RENAME_RULE_ID,
      effectiveAction: 'kick',
      kickEnqueued: true,
    });
    const rconCalls = rconXaddCalls(redis);
    expect(rconCalls).toHaveLength(1);
    const requestJson = rconCalls[0][rconCalls[0].length - 1] as string;
    const request = rconCommandRequestSchema.parse(JSON.parse(requestJson));
    expect(request.command).toBe('AdminKick');
    expect(request.args[0]).toBe(identity.eosId);
    expect(request.args[1]).toContain('запрещённый ник после смены');

    const [rule] = await db
      .select()
      .from(bannedNameRules)
      .where(eq(bannedNameRules.id, RENAME_RULE_ID));
    expect(rule.hitCount).toBe(1);
    expect(rule.lastHitAt).not.toBeNull();

    if (renamed.outcome !== 'handled') throw new Error('expected handled outcome');
    const actions = await db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.playerId, renamed.playerId as string));
    expect(actions).toHaveLength(1);
    expect(actions[0].context).toMatchObject({ rule_id: RENAME_RULE_ID, nickname: 'X' });

    const matchedEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'banname.matched')));
    expect(matchedEvents).toHaveLength(1);
    expect(matchedEvents[0].payload).toMatchObject({
      player_id: renamed.playerId,
      rule_id: RENAME_RULE_ID,
      nickname: 'X',
      action: 'kick',
    });
  });

  it('enqueues an AdminKick for a kick rule, targeting eos_id', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );

    expect(result).toMatchObject({ outcome: 'handled', ruleId: KICK_RULE_ID, kickEnqueued: true });
    const rconCalls = rconXaddCalls(redis);
    expect(rconCalls).toHaveLength(1);
    const xaddCall = rconCalls[0];
    const requestJson = xaddCall[xaddCall.length - 1] as string;
    const parsed = rconCommandRequestSchema.parse(JSON.parse(requestJson));
    expect(parsed.command).toBe('AdminKick');
    expect(parsed.args[0]).toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
    expect(parsed.args[1]).toContain('читер в нике');
  });

  it('falls back to steam_id64 as the kick target when eos_id is absent', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    await handleBannedNameEvent(
      db,
      redis,
      {
        serverId: SERVER_ID,
        event: connectEvent({ eosId: null, steamId64: '76561198990000002' }),
      },
      cache,
    );

    const xaddCall = rconXaddCalls(redis)[0];
    const requestJson = xaddCall[xaddCall.length - 1] as string;
    const parsed = rconCommandRequestSchema.parse(JSON.parse(requestJson));
    expect(parsed.args[0]).toBe('76561198990000002');
  });

  it('records a name_kick moderation action authored by the system', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );
    expect(result.outcome).toBe('handled');
    const playerId = result.outcome === 'handled' ? result.playerId : null;
    expect(playerId).not.toBeNull();

    const rows = await db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.playerId, playerId as string));
    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe('name_kick');
    expect(rows[0].authorSystemLabel).toBe('banname-worker');
    expect(rows[0].authorPlayerId).toBeNull();
    expect(rows[0].reason).toBe('читер в нике');
    expect(rows[0].context).toMatchObject({ rule_id: KICK_RULE_ID, nickname: 'ProCheaterOne' });
  });

  it('creates a new player row when no identity match exists yet', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );
    expect(result.outcome).toBe('handled');
    if (result.outcome !== 'handled') throw new Error('expected handled outcome');
    expect(result.playerId).not.toBeNull();

    const seeded = await db
      .select()
      .from(players)
      .where(eq(players.id, result.playerId as string));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].eosId).toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
  });

  it('increments hit_count and sets last_hit_at only on the matched rule', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    await handleBannedNameEvent(db, redis, { serverId: SERVER_ID, event: connectEvent() }, cache);

    const kickRule = await db
      .select()
      .from(bannedNameRules)
      .where(eq(bannedNameRules.id, KICK_RULE_ID));
    expect(kickRule[0].hitCount).toBe(1);
    expect(kickRule[0].lastHitAt).not.toBeNull();

    const alertRule = await db
      .select()
      .from(bannedNameRules)
      .where(eq(bannedNameRules.id, ALERT_RULE_ID));
    expect(alertRule[0].hitCount).toBe(0);
    expect(alertRule[0].lastHitAt).toBeNull();
  });

  it('persists and publishes a banname.matched event envelope', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );
    if (result.outcome !== 'handled') throw new Error('expected handled outcome');

    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'banname.matched')));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].payload).toMatchObject({
      rule_id: KICK_RULE_ID,
      nickname: 'ProCheaterOne',
      action: 'kick',
      escalated: false,
      player_id: result.playerId,
    });

    const liveBusCall = redis.publish.mock.calls.find((call) => call[0] === 'live-bus');
    expect(liveBusCall).toBeDefined();
    const frame = JSON.parse(liveBusCall?.[1] as string);
    expect(frame.type).toBe('banname.matched');
    expect(frame.data.action).toBe('kick');
  });

  it('does not kick, but alerts, records, and publishes for an alert rule', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      {
        serverId: SERVER_ID,
        event: connectEvent({ name: 'SuspectPlayer', steamId64: '76561198990000003' }),
      },
      cache,
    );

    expect(result).toMatchObject({
      outcome: 'handled',
      ruleId: ALERT_RULE_ID,
      kickEnqueued: false,
    });
    expect(rconXaddCalls(redis)).toHaveLength(0);

    const liveBusCall = redis.publish.mock.calls.find((call) => call[0] === 'live-bus');
    const frame = JSON.parse(liveBusCall?.[1] as string);
    expect(frame.data.action).toBe('alert');

    if (result.outcome !== 'handled') throw new Error('expected handled outcome');
    const rows = await db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.playerId, result.playerId as string));
    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe('name_kick');
  });

  it('cooldown: a second connect within 60s for the same identity+rule is a no-op', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const first = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );
    expect(first.outcome).toBe('handled');

    redis.xadd.mockClear();
    const second = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );
    expect(second).toEqual({ outcome: 'cooldown', ruleId: KICK_RULE_ID });
    expect(redis.xadd).not.toHaveBeenCalled();

    const kickRule = await db
      .select()
      .from(bannedNameRules)
      .where(eq(bannedNameRules.id, KICK_RULE_ID));
    expect(kickRule[0].hitCount).toBe(1);
  });

  it('escalation: downgrades the 4th kick within the window to an alert', async () => {
    const redis = makeRedis();
    const cache = new BannedNameRuleCache(db, 0);
    const eosId = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    const steamId64 = '76561198990000099';
    const results = [];
    for (let i = 0; i < 4; i++) {
      const result = await handleBannedNameEvent(
        db,
        redis,
        { serverId: SERVER_ID, event: connectEvent({ eosId, steamId64 }) },
        cache,
      );
      results.push(result);
      // The 60s cooldown would otherwise block every reconnect after the
      // first; clearing it simulates repeated reconnects >60s apart while
      // the same player is still inside the 10-minute escalation window.
      redis.__clearCooldowns();
    }

    expect(results[0]).toMatchObject({ outcome: 'handled', escalated: false, kickEnqueued: true });
    expect(results[1]).toMatchObject({ outcome: 'handled', escalated: false, kickEnqueued: true });
    expect(results[2]).toMatchObject({ outcome: 'handled', escalated: false, kickEnqueued: true });
    expect(results[3]).toMatchObject({
      outcome: 'handled',
      escalated: true,
      kickEnqueued: false,
      effectiveAction: 'alert',
    });
    expect(rconXaddCalls(redis)).toHaveLength(3);
    expect(redis.expire).toHaveBeenCalledWith(`banname:kicks:${eosId}`, 600);
  });

  it('swallows an rcon xadd failure and still writes the ledger with kick_enqueued=false', async () => {
    const redis = makeRedis();
    redis.xadd.mockRejectedValueOnce(new Error('worker-rcon unreachable'));
    const cache = new BannedNameRuleCache(db, 0);
    const result = await handleBannedNameEvent(
      db,
      redis,
      { serverId: SERVER_ID, event: connectEvent() },
      cache,
    );

    expect(result).toMatchObject({ outcome: 'handled', kickEnqueued: false });
    if (result.outcome !== 'handled') throw new Error('expected handled outcome');
    const rows = await db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.playerId, result.playerId as string));
    expect(rows[0].context).toMatchObject({ kick_enqueued: false });

    const kickRule = await db
      .select()
      .from(bannedNameRules)
      .where(eq(bannedNameRules.id, KICK_RULE_ID));
    expect(kickRule[0].hitCount).toBe(1);
  });
});
