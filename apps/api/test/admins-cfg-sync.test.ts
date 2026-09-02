import type { DatabaseClient } from '@squad/db';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_GROUP,
  ADMINS_CFG_SYNC_STREAM_PREFIX,
  type AdminsCfgSyncEvent,
  ensureAdminsCfgSyncGroup,
  publishAdminsCfgSyncForServer,
} from '../src/lib/admins-cfg-sync.js';

// `publishAdminsCfgSyncForAllServers` now writes to the durable Postgres outbox
// (SYNC-1, #34), so it can no longer be meaningfully unit-tested against a fake
// db. Its behaviour — one outbox row per active server, transactional
// atomicity/rollback and the relay — is
// covered end-to-end against real Postgres + Redis in
// `test/integration/admins-cfg-outbox.test.ts`.

const testEvent: AdminsCfgSyncEvent = {
  reason: 'role-change',
  actor_player_id: '76561198000000001',
  enqueued_at: '2026-01-01T00:00:00.000Z',
  request_id: 'req-123',
};

describe('publishAdminsCfgSyncForServer', () => {
  it('inserts one durable outbox row for the selected server', async () => {
    const serverId = 'bbbbbbbb-0000-0000-0000-000000000001';
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) } as unknown as DatabaseClient;

    await publishAdminsCfgSyncForServer(db, serverId, testEvent);

    expect(values).toHaveBeenCalledWith({
      serverId,
      payload: testEvent,
      correlationId: undefined,
    });
  });
});

describe('ensureAdminsCfgSyncGroup', () => {
  it('calls xgroup CREATE with correct args', async () => {
    const serverId = 'dddddddd-0000-0000-0000-000000000001';
    const xgroupArgs: unknown[][] = [];
    const redis = {
      xgroup: vi.fn((...args: unknown[]) => {
        xgroupArgs.push(args);
        return Promise.resolve('OK');
      }),
    } as unknown as Redis;

    await ensureAdminsCfgSyncGroup(redis, serverId);

    expect(xgroupArgs).toHaveLength(1);
    expect(xgroupArgs[0]?.[0]).toBe('CREATE');
    expect(xgroupArgs[0]?.[1]).toBe(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`);
    expect(xgroupArgs[0]?.[2]).toBe(ADMINS_CFG_SYNC_GROUP);
    expect(xgroupArgs[0]?.[3]).toBe('0');
    expect(xgroupArgs[0]?.[4]).toBe('MKSTREAM');
  });

  it('swallows BUSYGROUP error silently', async () => {
    const redis = {
      xgroup: vi.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
    } as unknown as Redis;

    await expect(
      ensureAdminsCfgSyncGroup(redis, 'eeeeeeee-0000-0000-0000-000000000001'),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-BUSYGROUP errors', async () => {
    const redis = {
      xgroup: vi
        .fn()
        .mockRejectedValue(
          new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
        ),
    } as unknown as Redis;

    await expect(
      ensureAdminsCfgSyncGroup(redis, 'ffffffff-0000-0000-0000-000000000001'),
    ).rejects.toThrow('WRONGTYPE');
  });
});

describe('constants', () => {
  it('ADMINS_CFG_SYNC_STREAM_PREFIX is the expected string', () => {
    expect(ADMINS_CFG_SYNC_STREAM_PREFIX).toBe('events:admins-cfg-sync:');
  });

  it('ADMINS_CFG_SYNC_GROUP is the expected string', () => {
    expect(ADMINS_CFG_SYNC_GROUP).toBe('config-sync');
  });
});
