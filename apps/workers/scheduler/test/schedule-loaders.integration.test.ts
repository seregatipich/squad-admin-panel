import { createDatabaseClient, rotationSchedule, seedSchedule, servers } from '@squad/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { loadEnabledRotationScheduleEntries, loadEnabledSeedScheduleEntries } from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;

describeIfDb('schedule loaders read only entries the tick can still execute', () => {
  const db = createDatabaseClient(DATABASE_URL ?? '');
  const serverId = uuidv7();
  const past = new Date('2026-07-01T10:00:00.000Z');
  const executed = new Date('2026-07-01T10:00:30.000Z');

  beforeAll(async () => {
    await db.insert(servers).values({
      id: serverId,
      displayName: 'schedule loader test server',
      slug: `schedule-loaders-${serverId}`,
    });
  });

  afterAll(async () => {
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.$client.end();
  });

  it('skips executed one-off rotation changes', async () => {
    const [pending, done] = await db
      .insert(rotationSchedule)
      .values([
        { serverId, scheduledAt: past, layer: 'Pending RAAS v1' },
        { serverId, scheduledAt: past, layer: 'Executed RAAS v1', lastExecutedAt: executed },
        { serverId, scheduledAt: past, layer: 'Disabled RAAS v1', enabled: false },
      ])
      .returning({ id: rotationSchedule.id });

    const ids = (await loadEnabledRotationScheduleEntries(db))
      .filter((entry) => entry.serverId === serverId)
      .map((entry) => entry.id);

    expect(ids).toEqual([pending?.id]);
    expect(ids).not.toContain(done?.id);
  });

  it('skips executed one-off seed starts but keeps executed recurring ones', async () => {
    const [pending, recurring] = await db
      .insert(seedSchedule)
      .values([
        { serverId, startsAt: past, seedLayer: 'Pending Seed v1' },
        {
          serverId,
          startsAt: past,
          seedLayer: 'Recurring Seed v1',
          recurrence: 'daily',
          lastExecutedAt: executed,
        },
        { serverId, startsAt: past, seedLayer: 'Executed Seed v1', lastExecutedAt: executed },
        { serverId, startsAt: past, seedLayer: 'Disabled Seed v1', enabled: false },
      ])
      .returning({ id: seedSchedule.id });

    const ids = (await loadEnabledSeedScheduleEntries(db))
      .filter((entry) => entry.serverId === serverId)
      .map((entry) => entry.id)
      .sort();

    expect(ids).toEqual([pending?.id, recurring?.id].sort());
  });
});
