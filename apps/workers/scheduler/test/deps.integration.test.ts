import { randomUUID } from 'node:crypto';
import {
  createDatabaseClient,
  rotationSchedule,
  scheduledTaskRuns,
  scheduledTasks,
  seedSchedule,
  servers,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import {
  createScheduledTaskDeps,
  loadEnabledRotationScheduleEntries,
  loadEnabledScheduledTasks,
  loadEnabledSeedScheduleEntries,
  pruneScheduledTaskRuns,
} from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;
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

describeIfDb('restartServer and run retention (#1002, #1016)', () => {
  it('restartServer flips the server status to starting', async () => {
    if (!db) throw new Error('database not configured');
    const bridge = {
      containerStop: async () => undefined,
      containerStart: async () => undefined,
      containerInspect: async () => ({ state: 'exited', running: false }),
    };
    const deps = createScheduledTaskDeps(db, { get: async () => null } as never, bridge as never);
    await deps.restartServer(liveServerId);
    const row = await db.query.servers.findFirst({
      where: eq(servers.id, liveServerId),
      columns: { status: true },
    });
    expect(row?.status).toBe('starting');
  });

  it('pruneScheduledTaskRuns deletes only runs older than the cutoff', async () => {
    if (!db) throw new Error('database not configured');
    const [task] = await db
      .insert(scheduledTasks)
      .values({
        serverId: liveServerId,
        name: 'prune fixture',
        taskType: 'restart',
        params: {},
        scheduledAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning({ id: scheduledTasks.id });
    if (!task) throw new Error('fixture not inserted');
    await db.insert(scheduledTaskRuns).values([
      { taskId: task.id, executedAt: new Date('2020-01-01T00:00:00.000Z'), status: 'failed' },
      { taskId: task.id, executedAt: new Date('2026-06-01T00:00:00.000Z'), status: 'failed' },
    ]);
    await pruneScheduledTaskRuns(db, new Date('2025-01-01T00:00:00.000Z'));
    const left = await db
      .select({ executedAt: scheduledTaskRuns.executedAt })
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, task.id));
    expect(left).toHaveLength(1);
    expect(left[0]?.executedAt.getUTCFullYear()).toBe(2026);
  });
});
