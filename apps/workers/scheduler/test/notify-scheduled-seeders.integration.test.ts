import { randomUUID } from 'node:crypto';
import { createDatabaseClient, events, servers } from '@squad/db';
import { serverSettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { notifyScheduledSeeders } from '../src/deps.js';
import type { SeedScheduleEntry } from '../src/seed-schedule-tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const serverId = randomUUID();
const misconfiguredServerId = randomUUID();

function makeEntry(overrides: Partial<SeedScheduleEntry> = {}): SeedScheduleEntry {
  return {
    id: randomUUID(),
    serverId,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    seedLayer: 'Sumari_Seed_v1',
    broadcastText: null,
    notifyMinutesBefore: 10,
    recurrence: null,
    lastExecutedAt: null,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]): Promise<'OK' | null> => {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) if (store.delete(key)) count++;
      return count;
    }),
    xadd: vi.fn().mockResolvedValue('0-1'),
    publish: vi.fn().mockResolvedValue(0),
    has: (key: string) => store.has(key),
  };
}

beforeAll(async () => {
  if (!db) return;
  await db.insert(servers).values([
    { id: serverId, displayName: 'Seed notify server', slug: `seed-notify-${serverId}` },
    {
      id: misconfiguredServerId,
      displayName: 'Seed notify — no settings',
      slug: `seed-notify-nosettings-${misconfiguredServerId}`,
    },
  ]);
  await db.insert(serverSettings).values({
    serverId,
    installPath: '/srv/squad',
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
});

afterAll(async () => {
  if (!db) return;
  await db.delete(events).where(eq(events.serverId, serverId));
  await db.delete(serverSettings).where(eq(serverSettings.serverId, serverId));
  await db.delete(servers).where(eq(servers.id, serverId));
  await db.delete(servers).where(eq(servers.id, misconfiguredServerId));
  await db.$client.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describeIfDb('notifyScheduledSeeders (#1003)', () => {
  it('does not claim the cooldown when the server has no serverSettings row', async () => {
    if (!db) throw new Error('database not configured');
    const redis = makeRedis();
    const bridge = { hostInfo: vi.fn() };
    const entry = makeEntry({ serverId: misconfiguredServerId });

    await notifyScheduledSeeders(db, redis, bridge, entry, new Date());

    expect(redis.set).not.toHaveBeenCalled();
    expect(bridge.hostInfo).not.toHaveBeenCalled();
  });

  it('does not claim the cooldown when the bridge host is unreachable', async () => {
    if (!db) throw new Error('database not configured');
    const redis = makeRedis();
    const bridge = { hostInfo: vi.fn().mockRejectedValue(new Error('bridge offline')) };
    const entry = makeEntry();

    await notifyScheduledSeeders(db, redis, bridge, entry, new Date());

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses bridge.hostInfo() for the join link, matching the API seed-call route', async () => {
    if (!db) throw new Error('database not configured');
    const redis = makeRedis();
    const bridge = {
      hostInfo: vi.fn().mockResolvedValue({ hostname: 'panel.example.com', ip_addresses: [] }),
    };
    const entry = makeEntry();

    await notifyScheduledSeeders(db, redis, bridge, entry, new Date('2026-01-01T00:00:00.000Z'));

    expect(redis.set).toHaveBeenCalledTimes(1);
    const insertedEvent = (await db.select().from(events).where(eq(events.serverId, serverId))).at(
      -1,
    );
    expect(insertedEvent?.payload).toMatchObject({
      join_link: 'steam://connect/panel.example.com:7787',
    });
  });

  it('falls back to the first ip_addresses entry when hostname is empty', async () => {
    if (!db) throw new Error('database not configured');
    const redis = makeRedis();
    const bridge = {
      hostInfo: vi.fn().mockResolvedValue({ hostname: '', ip_addresses: ['203.0.113.9'] }),
    };
    const entry = makeEntry();

    await notifyScheduledSeeders(db, redis, bridge, entry, new Date('2026-01-02T00:00:00.000Z'));

    const insertedEvent = (await db.select().from(events).where(eq(events.serverId, serverId))).at(
      -1,
    );
    expect(insertedEvent?.payload).toMatchObject({
      join_link: 'steam://connect/203.0.113.9:7787',
    });
  });

  it('releases the cooldown key when publishing the event fails after it was claimed', async () => {
    if (!db) throw new Error('database not configured');
    const redis = makeRedis();
    redis.xadd.mockRejectedValueOnce(new Error('redis down'));
    const bridge = {
      hostInfo: vi.fn().mockResolvedValue({ hostname: 'panel.example.com', ip_addresses: [] }),
    };
    const entry = makeEntry();
    const key = `seed:call:cooldown:${serverId}`;

    await expect(
      notifyScheduledSeeders(db, redis, bridge, entry, new Date('2026-01-03T00:00:00.000Z')),
    ).rejects.toThrow('redis down');

    expect(redis.has(key)).toBe(false);
  });
});
