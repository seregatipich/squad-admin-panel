import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileLinkedPlayers, syncPlayerDiscordRoles } from '../src/role-sync.js';
import {
  parseRoleSyncRequest,
  ROLE_SYNC_CONSUMER_GROUP,
  runRoleSyncLoop,
} from '../src/role-sync-consume.js';

vi.mock('../src/role-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/role-sync.js')>();
  return {
    ...actual,
    syncPlayerDiscordRoles: vi.fn(),
    reconcileLinkedPlayers: vi.fn(),
  };
});

const syncPlayerMock = vi.mocked(syncPlayerDiscordRoles);
const reconcileMock = vi.mocked(reconcileLinkedPlayers);

const silentLog = pino({ enabled: false });

const PLAYER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function fakeRedis(entries: Array<[string, string[]]>) {
  const acked: string[] = [];
  const statusWrites: Array<{ key: string; value: string }> = [];
  let served = false;
  return {
    acked,
    statusWrites,
    xgroup: vi.fn(async () => 'OK'),
    xautoclaim: vi.fn(async () => ['0-0', [], []]),
    xreadgroup: vi.fn(async () => {
      if (served) return null;
      served = true;
      return [['discord:role-sync', entries]];
    }),
    xack: vi.fn(async (_stream: string, _group: string, id: string) => {
      acked.push(id);
      return 1;
    }),
    set: vi.fn(async (key: string, value: string) => {
      statusWrites.push({ key, value });
      return 'OK';
    }),
  };
}

function makeOpts(redis: ReturnType<typeof fakeRedis>, overrides: Record<string, unknown> = {}) {
  let iterations = 0;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fake redis exposes only the commands the loop calls
    redis: redis as any,
    // biome-ignore lint/suspicious/noExplicitAny: the loop only forwards deps into role-sync.ts, which is mocked here
    db: {} as any,
    encryptionKey: Buffer.alloc(32, 0x42),
    fetchImpl: vi.fn() as unknown as typeof fetch,
    sleep: async () => undefined,
    log: silentLog,
    loadBotContext: async () => ({ guildId: '900000000000000001', botToken: 'tok' }),
    blockMs: 1,
    shouldStop: () => iterations++ > 0,
    ...overrides,
  };
}

beforeEach(() => {
  syncPlayerMock.mockReset();
  reconcileMock.mockReset();
  syncPlayerMock.mockResolvedValue({ outcome: 'synced', added: [], removed: [] });
  reconcileMock.mockResolvedValue({
    checked: 0,
    added: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
  });
});

describe('parseRoleSyncRequest', () => {
  it('reads a per-player request out of the XADD field array', () => {
    const fields = ['payload', JSON.stringify({ player_id: PLAYER_ID, reason: 'role.assign' })];
    expect(parseRoleSyncRequest(fields)).toEqual({ player_id: PLAYER_ID, reason: 'role.assign' });
  });

  it('reads a full-reconcile request (no player_id)', () => {
    const fields = ['payload', JSON.stringify({ player_id: null, reason: 'manual' })];
    expect(parseRoleSyncRequest(fields)).toEqual({ player_id: null, reason: 'manual' });
  });

  it('returns null for a malformed payload instead of throwing', () => {
    expect(parseRoleSyncRequest(['payload', '{not json'])).toBeNull();
    expect(parseRoleSyncRequest(['payload', JSON.stringify({ player_id: 7 })])).toBeNull();
    expect(parseRoleSyncRequest(['other', 'x'])).toBeNull();
  });
});

describe('runRoleSyncLoop', () => {
  it('syncs the named player and acks the entry', async () => {
    const redis = fakeRedis([
      ['1-1', ['payload', JSON.stringify({ player_id: PLAYER_ID, reason: 'role.assign' })]],
    ]);
    await runRoleSyncLoop(makeOpts(redis));

    expect(syncPlayerMock).toHaveBeenCalledTimes(1);
    expect(syncPlayerMock.mock.calls[0]?.[1]).toBe(PLAYER_ID);
    expect(redis.acked).toEqual(['1-1']);
  });

  it('runs a full reconcile when the request carries no player_id', async () => {
    const redis = fakeRedis([
      ['2-1', ['payload', JSON.stringify({ player_id: null, reason: 'manual' })]],
    ]);
    await runRoleSyncLoop(makeOpts(redis));

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(syncPlayerMock).not.toHaveBeenCalled();
    expect(redis.acked).toEqual(['2-1']);
  });

  it('acks a malformed entry without attempting a sync', async () => {
    const redis = fakeRedis([['3-1', ['payload', 'not-json']]]);
    await runRoleSyncLoop(makeOpts(redis));

    expect(syncPlayerMock).not.toHaveBeenCalled();
    expect(redis.acked).toEqual(['3-1']);
  });

  it('acks without syncing while the Discord bot is not configured', async () => {
    const redis = fakeRedis([
      ['4-1', ['payload', JSON.stringify({ player_id: PLAYER_ID, reason: 'role.assign' })]],
    ]);
    await runRoleSyncLoop(makeOpts(redis, { loadBotContext: async () => null }));

    expect(syncPlayerMock).not.toHaveBeenCalled();
    expect(redis.acked).toEqual(['4-1']);
  });

  it('publishes an error status a UI can read when the bot lacks Manage Roles', async () => {
    syncPlayerMock.mockResolvedValue({
      outcome: 'error',
      added: [],
      removed: [],
      error: {
        reason: 'missing_permissions',
        message: 'У бота нет права Manage Roles в Discord-гильдии.',
      },
    });
    const redis = fakeRedis([
      ['5-1', ['payload', JSON.stringify({ player_id: PLAYER_ID, reason: 'role.assign' })]],
    ]);
    await runRoleSyncLoop(makeOpts(redis));

    const status = redis.statusWrites.at(-1);
    expect(status?.key).toBe('discord:role-sync:status');
    expect(JSON.parse(status?.value ?? '{}')).toMatchObject({
      state: 'error',
      reason: 'missing_permissions',
      message: 'У бота нет права Manage Roles в Discord-гильдии.',
    });
  });

  it('publishes an ok status after a clean sync', async () => {
    const redis = fakeRedis([
      ['6-1', ['payload', JSON.stringify({ player_id: PLAYER_ID, reason: 'role.assign' })]],
    ]);
    await runRoleSyncLoop(makeOpts(redis));

    const status = redis.statusWrites.at(-1);
    expect(status?.key).toBe('discord:role-sync:status');
    expect(JSON.parse(status?.value ?? '{}')).toMatchObject({ state: 'ok' });
  });

  it('creates its consumer group on the dedicated role-sync stream', async () => {
    const redis = fakeRedis([]);
    await runRoleSyncLoop(makeOpts(redis));

    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      'discord:role-sync',
      ROLE_SYNC_CONSUMER_GROUP,
      '$',
      'MKSTREAM',
    );
  });
});
