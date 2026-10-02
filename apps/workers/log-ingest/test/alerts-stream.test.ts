import { setTimeout as sleep } from 'node:timers/promises';
import { alertEvents, alertRules, createDatabaseClient, servers } from '@squad/db';
import { type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { AlertRuleCache } from '../src/alerts/store.js';
import { ALERT_STREAM_GROUP, runAlertStreamConsumer } from '../src/alerts/stream.js';

/**
 * #27: a `custom` alert rule on an event worker-rcon publishes (the issue's
 * example is `rcon.disconnected`) never fired, because the engine ran only
 * inside log-ingest's per-line pipeline. This drives the stream reader the way
 * production does: an envelope XADDed to `events:server:<id>` in the shape of
 * worker-rcon's `ServerEvents.emitEvent`, a real rule in Postgres, a real
 * `alert_events` row as the observable result.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

const db = createDatabaseClient(DATABASE_URL ?? 'postgres://unused/unused');
const redis = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
const blocking = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const SERVER_ID = uuidv7();
const STREAM = STREAM_NAME.eventsServer(SERVER_ID);
const RULE = {
  disconnected: uuidv7(),
  serverStopped: uuidv7(),
  disabled: uuidv7(),
};
const ALL_RULES = Object.values(RULE);

let stopping = false;
let loop: Promise<void> | undefined;
const log = { warn: vi.fn(), error: vi.fn() };

/** The envelope worker-rcon's `ServerEvents.emitEvent` writes. */
function rconEnvelope(type: string, eventId = uuidv7()): EventEnvelope {
  return {
    event_id: eventId,
    version: 1,
    type,
    server_id: SERVER_ID,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {},
  } as EventEnvelope;
}

async function publishEvent(envelope: EventEnvelope): Promise<void> {
  await redis.xadd(STREAM, 'MAXLEN', '~', '10000', '*', 'envelope', JSON.stringify(envelope));
}

const alertsOf = (ruleId: string) =>
  db.select().from(alertEvents).where(eq(alertEvents.ruleId, ruleId));

async function waitFor(probe: () => Promise<boolean>, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

beforeAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  await redis.connect();
  await blocking.connect();
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Alert stream test server',
    slug: `alert-stream-${SERVER_ID}`,
  });
  await db.insert(alertRules).values([
    {
      id: RULE.disconnected,
      name: 'RCON lost',
      type: 'custom',
      config: { eventKind: 'rcon.disconnected', severity: 'critical' },
      channels: [],
      enabled: true,
    },
    {
      id: RULE.serverStopped,
      name: 'Server stopped',
      type: 'custom',
      config: { eventKind: 'server.stopped' },
      channels: [],
      enabled: true,
    },
    {
      id: RULE.disabled,
      name: 'RCON connected (off)',
      type: 'custom',
      config: { eventKind: 'rcon.connected' },
      channels: [],
      enabled: false,
    },
  ]);
  // The stream has to exist when the reader first looks: its group then starts
  // at the end, so only what the tests publish afterwards is delivered.
  await publishEvent(rconEnvelope('rcon.players_polled'));
  loop = runAlertStreamConsumer(
    {
      db,
      redis,
      rules: new AlertRuleCache(db, { ttlMs: 0 }),
      sink: {},
      log,
    },
    blocking,
    () => stopping,
  );
  await waitFor(async () => {
    const groups = (await redis.xinfo('GROUPS', STREAM)) as unknown[][];
    return groups.some((group) => group.includes(ALERT_STREAM_GROUP));
  });
});

afterAll(async () => {
  if (!DATABASE_URL || !REDIS_URL) return;
  stopping = true;
  await loop;
  await db.delete(alertEvents).where(inArray(alertEvents.ruleId, ALL_RULES));
  await db.delete(alertRules).where(inArray(alertRules.id, ALL_RULES));
  await redis.del(STREAM);
  const dedup = await redis.keys(`dedup:log-ingest-alerts:v1:*`);
  if (dedup.length > 0) await redis.del(...dedup);
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await blocking.quit();
  await redis.quit();
  await db.$client.end();
});

describeIfDbAndRedis('custom alert rules on events from worker-rcon (#27)', () => {
  it('fires a rule on rcon.disconnected and records the alert', async () => {
    await publishEvent(rconEnvelope('rcon.disconnected'));
    await waitFor(async () => (await alertsOf(RULE.disconnected)).length === 1);
    const [row] = await alertsOf(RULE.disconnected);
    expect(row).toMatchObject({ severity: 'critical' });
    expect(row?.payload).toMatchObject({
      eventType: 'rcon.disconnected',
      serverId: SERVER_ID,
      matchedKind: 'rcon.disconnected',
    });
  });

  it('raises one alert when the same event is delivered twice', async () => {
    const before = (await alertsOf(RULE.disconnected)).length;
    const replayed = rconEnvelope('rcon.disconnected');
    await publishEvent(replayed);
    await publishEvent(replayed);
    await waitFor(async () => (await alertsOf(RULE.disconnected)).length > before);
    await sleep(300);
    expect(await alertsOf(RULE.disconnected)).toHaveLength(before + 1);
  });

  it('does not evaluate a log-derived kind: the log tail already did, so the rule would alert twice', async () => {
    await publishEvent(rconEnvelope('server.stopped'));
    await sleep(500);
    expect(await alertsOf(RULE.serverStopped)).toHaveLength(0);
  });

  it('keeps a disabled rule silent', async () => {
    await publishEvent(rconEnvelope('rcon.connected'));
    await sleep(400);
    expect(await alertsOf(RULE.disabled)).toHaveLength(0);
  });

  it('survives a malformed entry and still serves the next event', async () => {
    const before = (await alertsOf(RULE.disconnected)).length;
    await redis.xadd(STREAM, '*', 'envelope', '{not json');
    await redis.xadd(STREAM, '*', 'something', 'else');
    await publishEvent(rconEnvelope('rcon.disconnected'));
    await waitFor(async () => (await alertsOf(RULE.disconnected)).length === before + 1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('leaves nothing pending once the entries were handled', async () => {
    await sleep(200);
    const pending = (await redis.xpending(STREAM, ALERT_STREAM_GROUP)) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });
});
