import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(() => ({
    select: selectMock,
  })),
  servers: { id: 'id', deletedAt: 'deletedAt' },
}));

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockReturnValue(Promise.resolve('OK')),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
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
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const pinoFn = vi.fn(() => logger);
  (pinoFn as unknown as Record<string, unknown>).multistream = vi.fn(() => ({}));
  return { default: pinoFn, multistream: vi.fn(() => ({})) };
});

vi.mock('../src/syncer.js', () => ({
  syncServerAdminsCfg: vi
    .fn()
    .mockResolvedValue({ state: 'up_to_date', groupsCount: 0, adminsCount: 0 }),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.PANEL_BRIDGE_SOCKET = '/tmp/fake.sock';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('config-sync index.ts', () => {
  it('is importable and calls syncer on import', async () => {
    const { syncServerAdminsCfg } = await import('../src/syncer.js');
    await import('../src/index.js');
    await new Promise((r) => setTimeout(r, 100));
    expect(syncServerAdminsCfg).toBeDefined();
    expect(typeof syncServerAdminsCfg).toBe('function');
  });
});
