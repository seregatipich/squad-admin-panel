import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => {
  const client = () => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    xadd: vi.fn().mockResolvedValue('id'),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(1),
    duplicate: vi.fn(() => client()),
  });
  return { default: vi.fn(client) };
});
vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(() => ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  })),
  servers: { id: 'id', status: 'status' },
  serverCredentials: { serverId: 'serverId', rconPasswordEncrypted: 'rconPasswordEncrypted' },
  serverSettings: { serverId: 'serverId' },
}));
vi.mock('@squad/shared-config', () => ({
  redisSinkStream: vi.fn(() => ({ write: vi.fn() })),
  resolveRconHost: vi.fn(() => '127.0.0.1'),
  startHeartbeat: vi.fn(() => vi.fn()),
  parseRconRefreshHint: vi.fn(() => null),
  RCON_REFRESH_CHANNEL: 'rcon:refresh',
}));
vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  const pinoFn = vi.fn(() => logger);
  (pinoFn as unknown as Record<string, unknown>).multistream = vi.fn(() => ({}));
  return { default: pinoFn, multistream: vi.fn(() => ({})) };
});

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('rcon index', () => {
  it('is importable without throwing', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
