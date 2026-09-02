import { randomUUID } from 'node:crypto';
import { adminsCfgSyncOutbox, clans, createDatabaseClient, servers } from '@squad/db';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markProcessed } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;
const clanId = randomUUID();
const serverId = randomUUID();
const requestId = `clan-priority-outbox-${randomUUID()}`;

beforeAll(async () => {
  if (!db) return;
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Clan priority outbox server',
    slug: `clan-priority-outbox-${serverId}`,
  });
  await db.insert(clans).values({
    id: clanId,
    name: `Outbox-${clanId.slice(0, 8)}`,
    priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
  });
});

afterAll(async () => {
  if (!db) return;
  await db
    .delete(adminsCfgSyncOutbox)
    .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${requestId}`);
  await db.delete(clans).where(eq(clans.id, clanId));
  await db.delete(servers).where(eq(servers.id, serverId));
  await db.$client.end();
});

describeIfDb('clan priority expiry transactional outbox', () => {
  it('commits the processed marker with one pending row per active server', async () => {
    if (!db) throw new Error('database not configured');
    const activeIds = (
      await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt))
    ).map((row) => row.id);

    const result = await markProcessed(db, [clanId], {
      reason: 'clan.priority.expire',
      actor_player_id: null,
      enqueued_at: '2026-07-14T10:00:00.000Z',
      request_id: requestId,
    });

    expect(result.enqueued).toBe(activeIds.length);
    expect(
      (await db.select().from(clans).where(eq(clans.id, clanId)))[0]?.priorityExpiryProcessed,
    ).toBe(true);
    const rows = await db
      .select({ serverId: adminsCfgSyncOutbox.serverId, relayedAt: adminsCfgSyncOutbox.relayedAt })
      .from(adminsCfgSyncOutbox)
      .where(sql`${adminsCfgSyncOutbox.payload}->>'request_id' = ${requestId}`);
    expect(new Set(rows.map((row) => row.serverId))).toEqual(new Set(activeIds));
    expect(rows.every((row) => row.relayedAt === null)).toBe(true);
  });
});
