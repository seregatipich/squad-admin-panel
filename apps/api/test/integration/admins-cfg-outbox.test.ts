import { relayAdminsCfgSyncOutbox } from '@squad/db';
import { adminsCfgSyncOutbox, roles, servers } from '@squad/db/schema';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_STREAM_PREFIX,
  type AdminsCfgSyncEvent,
  publishAdminsCfgSyncForAllServers,
} from '../../src/lib/admins-cfg-sync.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

async function activeServerIds(): Promise<string[]> {
  const rows = await h.db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
  return rows.map((r) => r.id);
}

function makeEvent(reason: string): AdminsCfgSyncEvent {
  return {
    reason,
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
    request_id: `outbox-test-${reason}-${Date.now()}`,
  };
}

describeIfDb('admins-cfg-sync durable outbox (SYNC-1)', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
    // Guarantee at least two active servers so "one outbox row per active
    // server" is a meaningful assertion.
    const existing = await activeServerIds();
    for (let i = existing.length; i < 2; i++) {
      await h.db.insert(servers).values({
        id: uuidv7(),
        displayName: `outbox-test-server-${i}`,
        slug: `outbox-test-${Date.now()}-${i}`,
      });
    }
  });

  afterAll(async () => {
    await h.app.close();
  });

  beforeEach(async () => {
    // Clean slate for each case: no pending/relayed outbox rows, drained streams.
    await h.db.delete(adminsCfgSyncOutbox);
    for (const id of await activeServerIds()) {
      await h.redis.del(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`);
    }
  });

  it('a committed mutation enqueues exactly one outbox row per active server, atomically', async () => {
    const serverIds = await activeServerIds();
    expect(serverIds.length).toBeGreaterThanOrEqual(2);
    const roleId = uuidv7();
    const event = makeEvent('role.create');

    await h.db.transaction(async (tx) => {
      await tx.insert(roles).values({ id: roleId, name: `outbox-atomic-${roleId}` });
      const result = await publishAdminsCfgSyncForAllServers(tx, h.redis, event);
      expect(result.enqueued).toBe(serverIds.length);
    });

    // The domain row committed…
    const roleRows = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
    expect(roleRows).toHaveLength(1);

    // …and so did exactly one outbox row per active server, carrying the event.
    const outboxRows = await h.db
      .select({
        serverId: adminsCfgSyncOutbox.serverId,
        payload: adminsCfgSyncOutbox.payload,
        relayedAt: adminsCfgSyncOutbox.relayedAt,
      })
      .from(adminsCfgSyncOutbox);
    expect(outboxRows).toHaveLength(serverIds.length);
    expect(new Set(outboxRows.map((r) => r.serverId))).toEqual(new Set(serverIds));
    for (const row of outboxRows) {
      expect((row.payload as AdminsCfgSyncEvent).request_id).toBe(event.request_id);
      // Redis is up in the harness, so the immediate best-effort dispatch marked
      // the rows relayed inside the same transaction.
      expect(row.relayedAt).not.toBeNull();
    }

    // Immediate dispatch also populated each server's stream.
    for (const id of serverIds) {
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)).toBeGreaterThanOrEqual(1);
    }
  });

  it('rolls the outbox rows back with the mutation — a rolled-back mutation leaves no sync task', async () => {
    const roleId = uuidv7();
    const event = makeEvent('role.rollback');

    await expect(
      h.db.transaction(async (tx) => {
        await tx.insert(roles).values({ id: roleId, name: `outbox-rollback-${roleId}` });
        await publishAdminsCfgSyncForAllServers(tx, h.redis, event);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Neither the domain row nor any outbox row survived the rollback.
    const roleRows = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
    expect(roleRows).toHaveLength(0);
    const outboxRows = await h.db.select({ id: adminsCfgSyncOutbox.id }).from(adminsCfgSyncOutbox);
    expect(outboxRows).toHaveLength(0);
  });

  it('commits the mutation and leaves the outbox row pending when the immediate publish fails', async () => {
    const serverIds = await activeServerIds();
    const roleId = uuidv7();
    const event = makeEvent('role.redis-down');

    // A redis whose pipeline().exec() rejects — models Redis being unreachable
    // at enqueue time. The mutation must still commit; the relay covers it later.
    const throwingRedis = {
      pipeline() {
        return {
          xadd() {
            return this;
          },
          exec() {
            return Promise.reject(new Error('ECONNREFUSED'));
          },
        };
      },
    } as unknown as Redis;

    await h.db.transaction(async (tx) => {
      await tx.insert(roles).values({ id: roleId, name: `outbox-redisdown-${roleId}` });
      await publishAdminsCfgSyncForAllServers(tx, throwingRedis, event);
    });

    const roleRows = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
    expect(roleRows).toHaveLength(1);

    const pending = await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox)
      .where(isNull(adminsCfgSyncOutbox.relayedAt));
    expect(pending).toHaveLength(serverIds.length);
  });

  it('relay delivers pending rows at-least-once and a re-run does not duplicate them', async () => {
    const serverIds = await activeServerIds();
    const event = makeEvent('relay');

    // Seed one pending row per server (as the Redis-down path would leave them).
    await h.db
      .insert(adminsCfgSyncOutbox)
      .values(serverIds.map((serverId) => ({ serverId, payload: event })));

    const first = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    expect(first.relayed).toBe(serverIds.length);

    // Every server's stream got exactly the one event, and every row is now
    // marked relayed with its assigned stream id.
    for (const id of serverIds) {
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)).toBe(1);
    }
    const relayed = await h.db
      .select({ streamId: adminsCfgSyncOutbox.streamId })
      .from(adminsCfgSyncOutbox)
      .where(isNotNull(adminsCfgSyncOutbox.relayedAt));
    expect(relayed).toHaveLength(serverIds.length);
    for (const row of relayed) {
      expect(row.streamId).not.toBeNull();
    }
    const stillPending = await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox)
      .where(isNull(adminsCfgSyncOutbox.relayedAt));
    expect(stillPending).toHaveLength(0);

    // Re-running the relay is a no-op: already-relayed rows are not re-published,
    // so no server's stream grows a second entry.
    const second = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    expect(second.relayed).toBe(0);
    for (const id of serverIds) {
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)).toBe(1);
    }
  });

  it("stamps a soft-deleted server's pending rows relayed without publishing (SYNC-5)", async () => {
    // A server that was soft-deleted after its sync task was enqueued.
    const deletedId = uuidv7();
    await h.db.insert(servers).values({
      id: deletedId,
      displayName: 'outbox-deleted-server',
      slug: `outbox-deleted-${Date.now()}`,
      deletedAt: new Date(),
    });
    const streamKey = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${deletedId}`;
    await h.redis.del(streamKey);
    await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId: deletedId, payload: makeEvent('post-delete') });

    const xaddSpy = vi.spyOn(h.redis, 'xadd');
    try {
      const { relayed } = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
      });
      expect(relayed).toBe(0);
      // No XADD targeted the deleted server's stream, so it was never resurrected.
      for (const call of xaddSpy.mock.calls) {
        expect(call[0]).not.toBe(streamKey);
      }
      expect(await h.redis.exists(streamKey)).toBe(0);
    } finally {
      xaddSpy.mockRestore();
    }

    // The orphan row is drained (stamped relayed) so the relay never loops on it.
    const stillPending = await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox)
      .where(
        and(eq(adminsCfgSyncOutbox.serverId, deletedId), isNull(adminsCfgSyncOutbox.relayedAt)),
      );
    expect(stillPending).toHaveLength(0);
  });
});
