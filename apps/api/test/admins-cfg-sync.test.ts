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
// atomicity/rollback, immediate best-effort dispatch, and the relay — is
// covered end-to-end against real Postgres + Redis in
// `test/integration/admins-cfg-outbox.test.ts`.

const testEvent: AdminsCfgSyncEvent = {
  reason: 'role-change',
  actor_player_id: '76561198000000001',
  enqueued_at: '2026-01-01T00:00:00.000Z',
  request_id: 'req-123',
};

describe('publishAdminsCfgSyncForServer', () => {
  it('calls xadd on the correct stream key', async () => {
    const serverId = 'bbbbbbbb-0000-0000-0000-000000000001';
    const xaddArgs: unknown[][] = [];
    const redis = {
      xadd: vi.fn((...args: unknown[]) => {
        xaddArgs.push(args);
        return Promise.resolve('1-0');
      }),
    } as unknown as Redis;

    await publishAdminsCfgSyncForServer(redis, serverId, testEvent);

    expect(xaddArgs).toHaveLength(1);
    expect(xaddArgs[0]?.[0]).toBe(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`);
  });

  it('includes MAXLEN trimming args', async () => {
    const serverId = 'cccccccc-0000-0000-0000-000000000001';
    const xaddArgs: unknown[][] = [];
    const redis = {
      xadd: vi.fn((...args: unknown[]) => {
        xaddArgs.push(args);
        return Promise.resolve('1-0');
      }),
    } as unknown as Redis;

    await publishAdminsCfgSyncForServer(redis, serverId, testEvent);

    const args = xaddArgs[0] as string[];
    expect(args).toContain('MAXLEN');
    expect(args).toContain('~');
    expect(args).toContain('500');
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
