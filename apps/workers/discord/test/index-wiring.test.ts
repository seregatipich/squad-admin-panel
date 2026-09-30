import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Boots `src/index.ts` with every loop mocked so the process-level wiring can
 * be asserted: which Redis connection each loop gets (#1294), what happens
 * when a loop dies unexpectedly (#880), and whether the notify chain's sleep
 * can be interrupted by shutdown (#893).
 */

interface FakeRedis {
  label: string;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
}

const created: FakeRedis[] = [];

function makeFakeRedis(label: string): FakeRedis {
  const redis: FakeRedis = {
    label,
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    duplicate: vi.fn(() => makeFakeRedis(`${label}:dup${created.length}`)),
  };
  created.push(redis);
  return redis;
}

vi.mock('ioredis', () => ({
  default: vi.fn(() => makeFakeRedis('main')),
}));
vi.mock('@squad/db', () => ({ createDatabaseClient: vi.fn(() => ({})) }));
vi.mock('@squad/shared-config', () => ({
  startHeartbeat: vi.fn(() => vi.fn()),
  createDiscordRedactingStream: vi.fn((inner) => inner),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});
vi.mock('../src/crypto.js', () => ({ loadEncryptionKey: vi.fn(() => Buffer.alloc(32)) }));
vi.mock('../src/consume.js', () => ({
  DEFAULT_RECLAIM_MIN_IDLE_MS: 60_000,
  runNotifyLoop: vi.fn(),
}));
vi.mock('../src/role-sync-consume.js', () => ({ runRoleSyncLoop: vi.fn() }));
vi.mock('../src/status-channel-loop.js', () => ({
  DEFAULT_STATUS_CHANNEL_TICK_MS: 600_000,
  runStatusChannelLoop: vi.fn(),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  created.length = 0;
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.DATABASE_URL = 'postgres://unused/unused';
  process.env.APP_ENCRYPTION_KEY = 'unused';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  delete process.env.DATABASE_URL;
  delete process.env.APP_ENCRYPTION_KEY;
});

async function boot() {
  const consume = await import('../src/consume.js');
  const roleSync = await import('../src/role-sync-consume.js');
  const statusChannel = await import('../src/status-channel-loop.js');
  const shared = await import('@squad/shared-config');
  return { consume, roleSync, statusChannel, shared };
}

describe('discord index wiring', () => {
  it('gives each blocking XREADGROUP loop its own Redis connection (#1294)', async () => {
    const { consume, roleSync, statusChannel, shared } = await boot();
    vi.mocked(consume.runNotifyLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(roleSync.runRoleSyncLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(statusChannel.runStatusChannelLoop).mockReturnValue(new Promise(() => {}));

    await import('../src/index.js');
    await vi.waitFor(() => expect(consume.runNotifyLoop).toHaveBeenCalled());

    const notifyRedis = vi.mocked(consume.runNotifyLoop).mock.calls.at(-1)?.[0].redis;
    const roleSyncRedis = vi.mocked(roleSync.runRoleSyncLoop).mock.calls.at(-1)?.[0].redis;
    const heartbeatRedis = vi.mocked(shared.startHeartbeat).mock.calls.at(-1)?.[0].redis;
    expect(notifyRedis).toBeDefined();
    expect(roleSyncRedis).toBeDefined();
    expect(notifyRedis).not.toBe(roleSyncRedis);
    expect(notifyRedis).not.toBe(heartbeatRedis);
    expect(roleSyncRedis).not.toBe(heartbeatRedis);
  });

  it('exits the process when a loop crashes before shutdown so compose restarts it (#880)', async () => {
    const { consume, roleSync, statusChannel } = await boot();
    vi.mocked(consume.runNotifyLoop).mockRejectedValue(new Error('LOADING'));
    vi.mocked(roleSync.runRoleSyncLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(statusChannel.runStatusChannelLoop).mockReturnValue(new Promise(() => {}));

    await import('../src/index.js');

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });

  it('exits the process when a loop returns on its own before shutdown (#880)', async () => {
    const { consume, roleSync, statusChannel } = await boot();
    vi.mocked(consume.runNotifyLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(roleSync.runRoleSyncLoop).mockResolvedValue(undefined);
    vi.mocked(statusChannel.runStatusChannelLoop).mockReturnValue(new Promise(() => {}));

    await import('../src/index.js');

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });

  it('lets shutdown interrupt the notify chain sleep instead of waiting out a retry delay (#893)', async () => {
    const { consume, roleSync, statusChannel } = await boot();
    vi.mocked(consume.runNotifyLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(roleSync.runRoleSyncLoop).mockReturnValue(new Promise(() => {}));
    vi.mocked(statusChannel.runStatusChannelLoop).mockReturnValue(new Promise(() => {}));

    await import('../src/index.js');
    await vi.waitFor(() => expect(consume.runNotifyLoop).toHaveBeenCalled());

    const notifySleep = vi.mocked(consume.runNotifyLoop).mock.calls.at(-1)?.[0].sleep;
    const pending = notifySleep?.(3_600_000);
    process.emit('SIGTERM', 'SIGTERM');
    await expect(pending).resolves.toBeUndefined();
  });
});
