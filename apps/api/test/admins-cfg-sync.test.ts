import type { DatabaseClient } from '@squad/db';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMINS_CFG_SYNC_GROUP,
  ADMINS_CFG_SYNC_STREAM_PREFIX,
  type AdminsCfgSyncEvent,
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

describe('constants', () => {
  it('ADMINS_CFG_SYNC_STREAM_PREFIX is the expected string', () => {
    expect(ADMINS_CFG_SYNC_STREAM_PREFIX).toBe('events:admins-cfg-sync:');
  });

  it('ADMINS_CFG_SYNC_GROUP is the expected string', () => {
    expect(ADMINS_CFG_SYNC_GROUP).toBe('config-sync');
  });
});
