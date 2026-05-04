import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockReturnValue(Promise.resolve('OK')),
  })),
}));

vi.mock('@squad/bridge-client', () => ({
  BridgeClient: vi.fn(() => ({
    hostMetrics: vi.fn(),
    close: vi.fn().mockReturnValue(Promise.resolve(undefined)),
  })),
}));

vi.mock('@squad/shared-config', () => ({
  redisSinkStream: vi.fn(() => ({ write: vi.fn() })),
  startHeartbeat: vi.fn(() => vi.fn()),
  HOST_METRICS_STREAM: 'host:metrics',
  HOST_METRICS_MAXLEN: 8640,
  packHostMetrics: vi.fn(() => []),
}));

vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const pinoFn = vi.fn(() => logger);
  (pinoFn as unknown as Record<string, unknown>).multistream = vi.fn(() => ({}));
  return { default: pinoFn, multistream: vi.fn(() => ({})) };
});

vi.mock('../src/lifecycle.js', () => ({
  emitStarted: vi.fn().mockResolvedValue(undefined),
  emitStopped: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/sampler.js', () => ({
  runSampler: vi.fn(() => vi.fn()),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.BRIDGE_SOCKET = '/tmp/fake.sock';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('metrics-sampler index.ts', () => {
  it('is importable and wires lifecycle + sampler', async () => {
    const { emitStarted } = await import('../src/lifecycle.js');
    const { runSampler } = await import('../src/sampler.js');
    await import('../src/index.js');
    await new Promise((r) => setTimeout(r, 50));
    expect(emitStarted).toHaveBeenCalled();
    expect(runSampler).toHaveBeenCalled();
  });
});
