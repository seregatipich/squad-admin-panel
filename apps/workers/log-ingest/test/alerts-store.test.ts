import {
  alertEvents,
  alertRules,
  createDatabaseClient,
  playerIpHistory,
  players,
  roles,
  servers,
} from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { AlertRuleCache, handleAlertEvent } from '../src/alerts/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const redis = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

const SERVER_ID = '00000000-0000-7000-8000-000000001901';
const ADMIN_ROLE_ID = '00000000-0000-7000-8000-000000001902';
const ADMIN_STEAM = '76561198100019001';
const PLAYER_STEAM = '76561198100019002';
const KNOWN_IP = '203.0.113.19';
const NEW_IP = '198.51.100.19';

const RULE = {
  crash: '00000000-0000-7000-8000-000000001911',
  crashDisabled: '00000000-0000-7000-8000-000000001912',
  flood: '00000000-0000-7000-8000-000000001913',
  adminIp: '00000000-0000-7000-8000-000000001914',
  custom: '00000000-0000-7000-8000-000000001915',
  customBroken: '00000000-0000-7000-8000-000000001916',
} as const;
const ALL_RULE_IDS = Object.values(RULE);

let eventSeq = 0;
function makeEvent(
  type: string,
  payload: Record<string, unknown> = {},
  ts = new Date().toISOString(),
): EventEnvelope {
  eventSeq += 1;
  return {
    event_id: `00000000-0000-7000-8000-${String(190000 + eventSeq).padStart(12, '0')}`,
    version: 1,
    type,
    server_id: SERVER_ID,
    ts,
    actor: null,
    correlation_id: null,
    payload,
  } as EventEnvelope;
}

function connect(steamId64: string, ip: string | null, ts?: string): EventEnvelope {
  return makeEvent(
    'player.connected',
    { name: `P${steamId64.slice(-4)}`, steam_id64: steamId64, eos_id: null, ip },
    ts,
  );
}

async function insertRule(
  id: string,
  type: string,
  config: Record<string, unknown>,
  enabled = true,
): Promise<void> {
  await db.insert(alertRules).values({
    id,
    name: `Test rule ${id.slice(-4)}`,
    type,
    config,
    channels: ['email'],
    enabled,
  });
}

async function alertRowsFor(ruleId: string) {
  return db.select().from(alertEvents).where(eq(alertEvents.ruleId, ruleId));
}

function freshCache(): AlertRuleCache {
  return new AlertRuleCache(db, { ttlMs: 0 });
}

async function flushTestKeys(): Promise<void> {
  const keys = await redis.keys(`*${SERVER_ID}*`);
  const ruleKeys = (await Promise.all(ALL_RULE_IDS.map((id) => redis.keys(`*${id}*`)))).flat();
  const dedupKeys = await redis.keys('dedup:log-ingest-alerts:v1:00000000-0000-7000-8000-0000001*');
  const all = [...keys, ...ruleKeys, ...dedupKeys];
  if (all.length > 0) await redis.del(...all);
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Alerts engine test server',
    slug: 'alerts-engine-test-server',
  });
  await db.insert(roles).values({
    id: ADMIN_ROLE_ID,
    name: 'AlertsEngineTestAdmin',
    panelAccess: true,
  });
  const [admin] = await db
    .insert(players)
    .values({
      steamId64: BigInt(ADMIN_STEAM),
      canonicalName: 'AlertsAdmin',
      canonicalNameNormalized: 'alertsadmin',
      roleId: ADMIN_ROLE_ID,
    })
    .returning({ id: players.id });
  await db.insert(playerIpHistory).values({ playerId: admin?.id as string, ip: KNOWN_IP });
  await db.insert(players).values({
    steamId64: BigInt(PLAYER_STEAM),
    canonicalName: 'AlertsPlayer',
    canonicalNameNormalized: 'alertsplayer',
  });
  await flushTestKeys();
});

afterEach(async () => {
  await db.delete(alertRules).where(inArray(alertRules.id, [...ALL_RULE_IDS]));
  await flushTestKeys();
});

afterAll(async () => {
  await db
    .delete(players)
    .where(inArray(players.steamId64, [BigInt(ADMIN_STEAM), BigInt(PLAYER_STEAM)]));
  await db.delete(roles).where(eq(roles.id, ADMIN_ROLE_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await redis.quit();
  await db.$client.end();
});

describeIfDbAndRedis('handleAlertEvent — server_crashed', () => {
  it('writes an alert_events row for an enabled rule and none for a disabled one', async () => {
    await insertRule(RULE.crash, 'server_crashed', {});
    await insertRule(RULE.crashDisabled, 'server_crashed', {}, false);
    const publish = vi.spyOn(redis, 'publish');

    const outcome = await handleAlertEvent(
      db,
      redis,
      freshCache(),
      makeEvent('server.crashed', { exit_code: 1 }),
    );

    expect(outcome).toMatchObject({ outcome: 'evaluated', raised: 1 });
    const fired = await alertRowsFor(RULE.crash);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ severity: 'critical', delivered: false });
    expect(fired[0]?.payload).toMatchObject({ eventType: 'server.crashed', serverId: SERVER_ID });
    expect(await alertRowsFor(RULE.crashDisabled)).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith('live-bus', expect.stringContaining('alert.triggered'));
    publish.mockRestore();
  });

  it('does not raise the alert twice when the tail replays the same event', async () => {
    await insertRule(RULE.crash, 'server_crashed', {});
    const event = makeEvent('server.crashed', { exit_code: 1 });

    await handleAlertEvent(db, redis, freshCache(), event);
    const replay = await handleAlertEvent(db, redis, freshCache(), event);

    expect(replay).toEqual({ outcome: 'duplicate' });
    expect(await alertRowsFor(RULE.crash)).toHaveLength(1);
  });

  it('marks the row delivered when a channel transport succeeds', async () => {
    await insertRule(RULE.crash, 'server_crashed', {});
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await handleAlertEvent(db, redis, freshCache(), makeEvent('server.crashed'), {
      emailConfig: { smtpUrl: 'smtp://mail.test', from: 'panel@test', to: ['ops@test'] },
      sendEmail,
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    const [row] = await alertRowsFor(RULE.crash);
    expect(row?.delivered).toBe(true);
  });
});

describeIfDbAndRedis('handleAlertEvent — unusual_activity', () => {
  it('fires once the connect count in the window reaches the threshold, then cools down', async () => {
    await insertRule(RULE.flood, 'unusual_activity', { windowMinutes: 5, connectThreshold: 3 });
    const cache = freshCache();
    const base = Date.now();
    const at = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await handleAlertEvent(db, redis, cache, connect(PLAYER_STEAM, null, at(i))));
    }

    expect(outcomes.map((o) => ('raised' in o ? o.raised : null))).toEqual([0, 0, 1, 0]);
    const rows = await alertRowsFor(RULE.flood);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ connectCount: 3, threshold: 3, windowMinutes: 5 });
  });

  it('does not count connects that fell out of the window', async () => {
    await insertRule(RULE.flood, 'unusual_activity', { windowMinutes: 1, connectThreshold: 2 });
    const cache = freshCache();
    const base = Date.now();

    await handleAlertEvent(
      db,
      redis,
      cache,
      connect(PLAYER_STEAM, null, new Date(base - 120_000).toISOString()),
    );
    await handleAlertEvent(
      db,
      redis,
      cache,
      connect(PLAYER_STEAM, null, new Date(base).toISOString()),
    );

    expect(await alertRowsFor(RULE.flood)).toHaveLength(0);
  });
});

describeIfDbAndRedis('handleAlertEvent — admin_login_new_ip', () => {
  it('fires for a panel admin connecting from an IP missing from their history', async () => {
    await insertRule(RULE.adminIp, 'admin_login_new_ip', {});
    const cache = freshCache();

    await handleAlertEvent(db, redis, cache, connect(ADMIN_STEAM, KNOWN_IP));
    expect(await alertRowsFor(RULE.adminIp)).toHaveLength(0);

    await handleAlertEvent(db, redis, cache, connect(ADMIN_STEAM, NEW_IP));
    const rows = await alertRowsFor(RULE.adminIp);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ ip: NEW_IP });
    expect(rows[0]?.payload).toHaveProperty('actorId');
    expect((rows[0]?.payload as { actorId: unknown }).actorId).not.toBeNull();
  });

  it('never fires for a player without panel access', async () => {
    await insertRule(RULE.adminIp, 'admin_login_new_ip', {});

    await handleAlertEvent(db, redis, freshCache(), connect(PLAYER_STEAM, NEW_IP));

    expect(await alertRowsFor(RULE.adminIp)).toHaveLength(0);
  });

  it('keeps the live-bus frame free of the admin IP', async () => {
    await insertRule(RULE.adminIp, 'admin_login_new_ip', {});
    const publish = vi.spyOn(redis, 'publish');

    await handleAlertEvent(db, redis, freshCache(), connect(ADMIN_STEAM, NEW_IP));

    const frames = publish.mock.calls.filter((call) => call[0] === 'live-bus');
    expect(frames).toHaveLength(1);
    expect(String(frames[0]?.[1])).not.toContain(NEW_IP);
    publish.mockRestore();
  });
});

describeIfDbAndRedis('handleAlertEvent — custom', () => {
  it('fires on every threshold-th matching event and resets the count', async () => {
    await insertRule(RULE.custom, 'custom', { eventKind: 'server.stopped', threshold: 2 });
    const cache = freshCache();

    const raised = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await handleAlertEvent(db, redis, cache, makeEvent('server.stopped'));
      raised.push('raised' in outcome ? outcome.raised : null);
    }

    expect(raised).toEqual([0, 1, 0, 1]);
    expect(await alertRowsFor(RULE.custom)).toHaveLength(2);
  });

  it('skips a rule whose stored config fails validation instead of crashing', async () => {
    await insertRule(RULE.customBroken, 'custom', {});
    await insertRule(RULE.crash, 'server_crashed', {});
    const onInvalidRule = vi.fn();

    const outcome = await handleAlertEvent(
      db,
      redis,
      new AlertRuleCache(db, { ttlMs: 0, onInvalidRule }),
      makeEvent('server.crashed'),
    );

    expect(outcome).toMatchObject({ outcome: 'evaluated', raised: 1 });
    expect(onInvalidRule).toHaveBeenCalledWith(RULE.customBroken, expect.any(String));
    expect(await alertRowsFor(RULE.customBroken)).toHaveLength(0);
  });
});
