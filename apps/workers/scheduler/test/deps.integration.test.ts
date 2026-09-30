import { randomUUID } from 'node:crypto';
import {
  createDatabaseClient,
  rotationSchedule,
  scheduledTasks,
  seedSchedule,
  servers,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createScheduledTaskDeps,
  loadEnabledRotationScheduleEntries,
  loadEnabledScheduledTasks,
  loadEnabledSeedScheduleEntries,
} from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const liveServerId = randomUUID();
const deletedServerId = randomUUID();
const externalServerId = randomUUID();

beforeAll(async () => {
  if (!db) return;
  await db.insert(servers).values([
    {
      id: liveServerId,
      displayName: 'Deps loader — live',
      slug: `deps-loader-live-${liveServerId}`,
    },
    {
      id: deletedServerId,
      displayName: 'Deps loader — deleted',
      slug: `deps-loader-deleted-${deletedServerId}`,
      deletedAt: new Date(),
    },
    {
      id: externalServerId,
      displayName: 'Deps loader — external',
      slug: `deps-loader-external-${externalServerId}`,
      runtime: 'external',
    },
  ]);

  await db.insert(seedSchedule).values([
    {
      serverId: liveServerId,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      seedLayer: 'Sumari_Seed_v1',
      enabled: true,
    },
    {
      serverId: deletedServerId,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      seedLayer: 'Sumari_Seed_v1',
      enabled: true,
    },
  ]);

  await db.insert(rotationSchedule).values([
    {
      serverId: liveServerId,
      scheduledAt: new Date('2026-01-01T00:00:00.000Z'),
      layer: 'Yehorivka_RAAS_v11',
      enabled: true,
    },
    {
      serverId: deletedServerId,
      scheduledAt: new Date('2026-01-01T00:00:00.000Z'),
      layer: 'Yehorivka_RAAS_v11',
      enabled: true,
    },
  ]);

  await db.insert(scheduledTasks).values([
    {
      serverId: liveServerId,
      name: 'Deps loader task — live',
      taskType: 'broadcast',
      params: { message: 'hi' },
      scheduledAt: new Date('2026-01-01T00:00:00.000Z'),
      enabled: true,
    },
    {
      serverId: deletedServerId,
      name: 'Deps loader task — deleted',
      taskType: 'broadcast',
      params: { message: 'hi' },
      scheduledAt: new Date('2026-01-01T00:00:00.000Z'),
      enabled: true,
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(seedSchedule).where(eq(seedSchedule.serverId, liveServerId));
  await db.delete(seedSchedule).where(eq(seedSchedule.serverId, deletedServerId));
  await db.delete(rotationSchedule).where(eq(rotationSchedule.serverId, liveServerId));
  await db.delete(rotationSchedule).where(eq(rotationSchedule.serverId, deletedServerId));
  await db.delete(scheduledTasks).where(eq(scheduledTasks.serverId, liveServerId));
  await db.delete(scheduledTasks).where(eq(scheduledTasks.serverId, deletedServerId));
  await db.delete(servers).where(eq(servers.id, liveServerId));
  await db.delete(servers).where(eq(servers.id, deletedServerId));
  await db.delete(servers).where(eq(servers.id, externalServerId));
  await db.$client.end();
});

describeIfDb('scheduler loaders exclude soft-deleted servers (#1001)', () => {
  it('loadEnabledSeedScheduleEntries drops rows for a soft-deleted server', async () => {
    if (!db) throw new Error('database not configured');
    const rows = await loadEnabledSeedScheduleEntries(db);
    const serverIds = rows.map((row) => row.serverId);
    expect(serverIds).toContain(liveServerId);
    expect(serverIds).not.toContain(deletedServerId);
  });

  it('loadEnabledRotationScheduleEntries drops rows for a soft-deleted server', async () => {
    if (!db) throw new Error('database not configured');
    const rows = await loadEnabledRotationScheduleEntries(db);
    const serverIds = rows.map((row) => row.serverId);
    expect(serverIds).toContain(liveServerId);
    expect(serverIds).not.toContain(deletedServerId);
  });

  it('loadEnabledScheduledTasks drops rows for a soft-deleted server', async () => {
    if (!db) throw new Error('database not configured');
    const rows = await loadEnabledScheduledTasks(db);
    const serverIds = rows.map((row) => row.serverId);
    expect(serverIds).toContain(liveServerId);
    expect(serverIds).not.toContain(deletedServerId);
  });

  it('restartServer refuses a soft-deleted server instead of retrying forever (#1001)', async () => {
    if (!db) throw new Error('database not configured');
    const deps = createScheduledTaskDeps(
      db,
      { get: async () => null } as never,
      { containerStop: async () => undefined, containerStart: async () => undefined } as never,
    );
    await expect(deps.restartServer(deletedServerId)).rejects.toThrow(/not found or deleted/);
  });

  it('restartServer still refuses an external server', async () => {
    if (!db) throw new Error('database not configured');
    const deps = createScheduledTaskDeps(
      db,
      { get: async () => null } as never,
      { containerStop: async () => undefined, containerStart: async () => undefined } as never,
    );
    await expect(deps.restartServer(externalServerId)).rejects.toThrow(/is external/);
  });
});
