import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

let selectedServers: Array<{ id: string }> = [];

const selectMock = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockImplementation(() => Promise.resolve(selectedServers)),
  }),
});

vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(() => ({
    select: selectMock,
  })),
  servers: { id: 'id', deletedAt: 'deletedAt' },
}));

const redisMock = vi.hoisted(() => ({
  xreadgroup: vi
    .fn()
    .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 50))),
}));

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockReturnValue(Promise.resolve('OK')),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: redisMock.xreadgroup,
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    xack: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('@squad/bridge-client', () => ({
  BridgeClient: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockReturnValue(Promise.resolve(undefined)),
    fileRead: vi.fn().mockResolvedValue({ content: '' }),
    fileAtomicWrite: vi.fn().mockResolvedValue({ written: true }),
  })),
}));

vi.mock('@squad/shared-config', () => ({
  redisSinkStream: vi.fn(() => ({ write: vi.fn() })),
  startHeartbeat: vi.fn(() => vi.fn()),
}));

vi.mock('drizzle-orm', () => ({
  isNull: vi.fn(() => ({})),
}));

vi.mock('pino', () => {
  const pinoFn = vi.fn(() => mockLogger);
  (pinoFn as unknown as Record<string, unknown>).multistream = vi.fn(() => ({}));
  return { default: pinoFn, multistream: vi.fn(() => ({})) };
});

vi.mock('../src/syncer.js', () => ({
  syncServerAdminsCfg: vi
    .fn()
    .mockResolvedValue({ state: 'in_sync', groupsCount: 0, adminsCount: 0 }),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  selectedServers = [{ id: SERVER_ID }];
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.PANEL_BRIDGE_SOCKET = '/tmp/fake.sock';
  process.env.ADMINS_CFG_DRIFT_INTERVAL_MS = '10';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(async () => {
  process.emit('SIGTERM', 'SIGTERM');
  await new Promise((r) => setTimeout(r, 20));
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  delete process.env.ADMINS_CFG_DRIFT_INTERVAL_MS;
});

describe('config-sync index.ts', () => {
  it('is importable and calls syncer on import', async () => {
    const { syncServerAdminsCfg } = await import('../src/syncer.js');
    await import('../src/index.js');
    await new Promise((r) => setTimeout(r, 100));
    expect(syncServerAdminsCfg).toBeDefined();
    expect(typeof syncServerAdminsCfg).toBe('function');
  });

  it('logs passive drift as awaiting force-sync', async () => {
    const { syncServerAdminsCfg } = await import('../src/syncer.js');
    vi.mocked(syncServerAdminsCfg).mockResolvedValueOnce({
      state: 'drift',
      serverId: SERVER_ID,
      expectedHash: 'expected',
      actualHash: 'actual',
      groupsCount: 0,
      adminsCount: 0,
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { serverId: SERVER_ID, expected: 'expected', actual: 'actual' },
      'admins.cfg drift detected — awaiting force-sync',
    );
  });

  it('refreshes the server list immediately on a NOGROUP xreadgroup error (SYNC-5)', async () => {
    // A destroyed per-server stream/group (server soft-deleted) makes the
    // multiplexed XREADGROUP reject NOGROUP for the whole batch. The worker
    // must re-query the server list at once and resume, not stall.
    const selectCallsBefore = selectMock.mock.calls.length;
    redisMock.xreadgroup.mockImplementationOnce(() =>
      Promise.reject(new Error("NOGROUP No such key 'events:admins-cfg-sync:x' or consumer group")),
    );

    await new Promise((r) => setTimeout(r, 200));

    // refreshServerList() re-queried the DB in direct response to the NOGROUP.
    expect(selectMock.mock.calls.length).toBeGreaterThan(selectCallsBefore);

    // The run loop kept polling afterwards — the read recovered rather than stalling.
    const readsAfter = redisMock.xreadgroup.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(redisMock.xreadgroup.mock.calls.length).toBeGreaterThan(readsAfter);
  });
});
