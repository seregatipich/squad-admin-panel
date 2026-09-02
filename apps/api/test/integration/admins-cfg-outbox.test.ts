import { type OutboxRelayRedis, relayAdminsCfgSyncOutbox } from '@squad/db';
import { adminsCfgSyncOutbox, roles, servers } from '@squad/db/schema';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_STREAM_PREFIX,
  type AdminsCfgSyncEvent,
  ensureAdminsCfgSyncGroup,
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

async function streamEvents(serverId: string): Promise<Array<Record<string, unknown>>> {
  const entries = await h.redis.xrange(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`, '-', '+');
  return entries.map(([, fields]) => {
    const eventIndex = fields.indexOf('event');
    if (eventIndex < 0) throw new Error('stream entry has no event field');
    return JSON.parse(fields[eventIndex + 1] ?? 'null') as Record<string, unknown>;
  });
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

  it('keeps rows invisible and performs no XADD before commit, then lets the relay publish', async () => {
    const serverIds = await activeServerIds();
    expect(serverIds.length).toBeGreaterThanOrEqual(2);
    const roleId = uuidv7();
    const event = makeEvent('role.create');

    let continueCommit: () => void = () => undefined;
    let inserted: () => void = () => undefined;
    const waitForCommit = new Promise<void>((resolve) => {
      continueCommit = resolve;
    });
    const waitForInsert = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const transaction = h.db.transaction(async (tx) => {
      await tx.insert(roles).values({ id: roleId, name: `outbox-atomic-${roleId}` });
      const result = await publishAdminsCfgSyncForAllServers(tx, event);
      expect(result.enqueued).toBe(serverIds.length);
      inserted();
      await waitForCommit;
    });

    await waitForInsert;
    const beforeCommitRows = await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox);
    const beforeCommitRelay = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    const beforeCommitStreamSizes = await Promise.all(
      serverIds.map((id) => h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)),
    );
    continueCommit();
    await transaction;

    expect(beforeCommitRows).toHaveLength(0);
    expect(beforeCommitRelay.relayed).toBe(0);
    expect(beforeCommitStreamSizes).toEqual(serverIds.map(() => 0));

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
      expect(row.relayedAt).toBeNull();
    }

    const roleRows = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
    expect(roleRows).toHaveLength(1);
    for (const id of serverIds) {
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)).toBe(0);
    }

    const afterCommitRelay = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    expect(afterCommitRelay.relayed).toBe(serverIds.length);
  });

  it('rolls the outbox rows back with the mutation — a rolled-back mutation leaves no sync task', async () => {
    const roleId = uuidv7();
    const event = makeEvent('role.rollback');

    await expect(
      h.db.transaction(async (tx) => {
        await tx.insert(roles).values({ id: roleId, name: `outbox-rollback-${roleId}` });
        await publishAdminsCfgSyncForAllServers(tx, event);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Neither the domain row nor any outbox row survived the rollback.
    const roleRows = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId));
    expect(roleRows).toHaveLength(0);
    const outboxRows = await h.db.select({ id: adminsCfgSyncOutbox.id }).from(adminsCfgSyncOutbox);
    expect(outboxRows).toHaveLength(0);
    for (const id of await activeServerIds()) {
      expect(await h.redis.xlen(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`)).toBe(0);
    }
  });

  it('enqueues one correlated row for each id in the lifecycle server snapshot only', async () => {
    const serverIds = await activeServerIds();
    const snapshot = serverIds.slice(0, 1);
    const eventId = `evt_${uuidv7()}`;
    const event = makeEvent('vip.lifecycle.assigned');

    await h.db.transaction(async (tx) => {
      await publishAdminsCfgSyncForAllServers(tx, event, snapshot, eventId);
    });

    const rows = await h.db
      .select({
        serverId: adminsCfgSyncOutbox.serverId,
        correlationId: adminsCfgSyncOutbox.correlationId,
        relayedAt: adminsCfgSyncOutbox.relayedAt,
      })
      .from(adminsCfgSyncOutbox);
    expect(rows).toEqual([{ serverId: snapshot[0], correlationId: eventId, relayedAt: null }]);
  });

  it('retries after a crash following XADD with the same stable _outbox_id', async () => {
    const [serverId] = await activeServerIds();
    if (!serverId) throw new Error('expected an active server');
    const [{ id: outboxId }] = await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId, payload: makeEvent('relay-crash') })
      .returning({ id: adminsCfgSyncOutbox.id });

    let crash = true;
    const crashingRedis: OutboxRelayRedis = {
      xadd: async (key, ...args) => {
        const streamId = await h.redis.xadd(key, ...args);
        if (crash) {
          crash = false;
          throw new Error('relay crashed after XADD');
        }
        return streamId;
      },
    };

    await expect(
      relayAdminsCfgSyncOutbox(h.db, crashingRedis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
      }),
    ).rejects.toThrow('relay crashed after XADD');
    const [pending] = await h.db
      .select({ relayedAt: adminsCfgSyncOutbox.relayedAt })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, outboxId));
    expect(pending?.relayedAt).toBeNull();
    expect(await streamEvents(serverId)).toEqual([
      expect.objectContaining({ _outbox_id: outboxId }),
    ]);

    const retry = await relayAdminsCfgSyncOutbox(h.db, h.redis, {
      streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
    });
    expect(retry.relayed).toBe(1);
    const events = await streamEvents(serverId);
    expect(events).toHaveLength(2);
    expect(events.map((entry) => entry._outbox_id)).toEqual([outboxId, outboxId]);
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

  it('keeps a row pending when XADD returns no stream id', async () => {
    const [serverId] = await activeServerIds();
    if (!serverId) throw new Error('expected an active server');
    const [{ id }] = await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId, payload: makeEvent('null-stream-id') })
      .returning({ id: adminsCfgSyncOutbox.id });
    const redis: OutboxRelayRedis = { xadd: async () => null };

    await expect(
      relayAdminsCfgSyncOutbox(h.db, redis, { streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX }),
    ).rejects.toThrow('admins_cfg_outbox_xadd_missing_stream_id');

    const [row] = await h.db
      .select({ relayedAt: adminsCfgSyncOutbox.relayedAt })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, id));
    expect(row?.relayedAt).toBeNull();
  });

  it('bounds a stalled XADD and leaves the row pending for retry', async () => {
    const [serverId] = await activeServerIds();
    if (!serverId) throw new Error('expected an active server');
    const [{ id }] = await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId, payload: makeEvent('relay-timeout') })
      .returning({ id: adminsCfgSyncOutbox.id });
    const stalledRedis: OutboxRelayRedis = {
      xadd: () => new Promise(() => undefined),
    };

    await expect(
      relayAdminsCfgSyncOutbox(h.db, stalledRedis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
        xaddTimeoutMs: 20,
      }),
    ).rejects.toThrow('admins_cfg_outbox_xadd_timeout');

    const [row] = await h.db
      .select({ relayedAt: adminsCfgSyncOutbox.relayedAt })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.id, id));
    expect(row?.relayedAt).toBeNull();
  });

  it('reads a relayed entry when the consumer group is created after XADD', async () => {
    const [serverId] = await activeServerIds();
    if (!serverId) throw new Error('expected an active server');
    const stream = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`;
    await h.db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId, payload: makeEvent('group-after-relay') });
    expect(
      await relayAdminsCfgSyncOutbox(h.db, h.redis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
      }),
    ).toEqual({ relayed: 1 });

    await ensureAdminsCfgSyncGroup(h.redis, serverId);
    const read = await h.redis.xreadgroup(
      'GROUP',
      'config-sync',
      'late-consumer',
      'COUNT',
      1,
      'STREAMS',
      stream,
      '>',
    );
    expect(read?.[0]?.[1]).toHaveLength(1);
  });

  it('does not trim unconsumed entries when a pending batch exceeds the old stream cap', async () => {
    const [serverId] = await activeServerIds();
    if (!serverId) throw new Error('expected an active server');
    const rowCount = 550;
    await h.db.insert(adminsCfgSyncOutbox).values(
      Array.from({ length: rowCount }, (_, index) => ({
        serverId,
        payload: makeEvent(`load-${index}`),
      })),
    );

    expect(
      await relayAdminsCfgSyncOutbox(h.db, h.redis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
      }),
    ).toEqual({ relayed: rowCount });

    const events = await streamEvents(serverId);
    expect(events).toHaveLength(rowCount);
    expect(new Set(events.map((event) => event._outbox_id)).size).toBe(rowCount);
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
    await h.db.insert(adminsCfgSyncOutbox).values({
      serverId: deletedId,
      payload: makeEvent('post-delete'),
      correlationId: 'deleted-lifecycle-event',
    });

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
    const completed = await h.db
      .select({
        appliedAt: adminsCfgSyncOutbox.appliedAt,
        reloadOutcome: adminsCfgSyncOutbox.reloadOutcome,
        lastError: adminsCfgSyncOutbox.lastError,
      })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.serverId, deletedId));
    expect(completed).toEqual([
      { appliedAt: expect.any(Date), reloadOutcome: 'server_removed', lastError: null },
    ]);
  });
});
