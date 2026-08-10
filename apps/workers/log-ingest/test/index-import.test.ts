import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    xadd: vi.fn().mockResolvedValue('id'),
  })),
}));
vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(() => ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockResolvedValue([]),
      }),
    }),
  })),
  findConfirmedAltLinks: vi.fn().mockResolvedValue([]),
  moderationActions: { playerId: 'playerId', actionType: 'actionType', revertedAt: 'revertedAt' },
  players: { id: 'id', steamId64: 'steamId64', eosId: 'eosId' },
  raiseAltBanAlert: vi.fn().mockResolvedValue(0),
  servers: { id: 'id', status: 'status' },
  serverSettings: { serverId: 'serverId', logsEnabled: 'logsEnabled' },
}));
vi.mock('@squad/bridge-client', () => ({
  BridgeClient: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    containerLogsFollow: vi.fn().mockResolvedValue({ stop: vi.fn() }),
    squadLogRetentionSweep: vi.fn().mockResolvedValue({
      retention_days: 10,
      cutoff: '2026-06-27T12:00:00Z',
      servers_scanned: 0,
      log_dirs_scanned: 0,
      files_scanned: 0,
      deleted_count: 0,
      deleted_bytes: 0,
      error_count: 0,
      errors: [],
    }),
  })),
}));
vi.mock('@squad/shared-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@squad/shared-config')>();
  return {
    ...actual,
    redisSinkStream: vi.fn(() => ({ write: vi.fn() })),
    startHeartbeat: vi.fn(() => vi.fn()),
    filterCutoverServers: vi.fn(async (_redis: unknown, ids: string[]) => ({ legacy: ids })),
  };
});
vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
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
  process.env.PANEL_BRIDGE_SOCKET = '/tmp/fake.sock';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('log-ingest index', () => {
  it('is importable without throwing', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
