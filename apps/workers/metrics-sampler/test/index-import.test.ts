import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  bridgeClose: vi.fn().mockResolvedValue(undefined),
  bridgeOnLog: undefined as ((message: string, meta?: Record<string, unknown>) => void) | undefined,
  heartbeatOnError: undefined as ((err: Error) => void) | undefined,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  redisHandlers: new Map<string, (...args: never[]) => void>(),
  redisOptions: undefined as { retryStrategy?: (times: number) => number } | undefined,
  redisQuit: vi.fn().mockResolvedValue('OK'),
  shutdownOptions: undefined as
    | {
        cleanup: (signal: NodeJS.Signals) => Promise<void>;
        onError?: (err: Error) => void;
      }
    | undefined,
  stopHeartbeat: vi.fn(),
  stopSampler: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: vi.fn((_url: string, options: typeof harness.redisOptions) => {
    harness.redisOptions = options;
    return {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        harness.redisHandlers.set(event, handler);
      }),
      quit: harness.redisQuit,
    };
  }),
}));

vi.mock('@squad/bridge-client', () => ({
  BridgeClient: vi.fn(
    (options: { onLog?: (message: string, meta?: Record<string, unknown>) => void }) => {
      harness.bridgeOnLog = options.onLog;
      return {
        hostMetrics: vi.fn(),
        close: harness.bridgeClose,
      };
    },
  ),
}));

vi.mock('@squad/shared-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@squad/shared-config')>();
  return {
    ...actual,
    redisSinkStream: vi.fn(() => ({ write: vi.fn() })),
    startHeartbeat: vi.fn((options: { onError?: (err: Error) => void }) => {
      harness.heartbeatOnError = options.onError;
      return harness.stopHeartbeat;
    }),
    createGracefulShutdownController: vi.fn(
      (options: {
        cleanup: (signal: NodeJS.Signals) => Promise<void>;
        onError?: (err: Error) => void;
      }) => {
        harness.shutdownOptions = options;
        return { markReady: vi.fn().mockResolvedValue(undefined) };
      },
    ),
    HOST_METRICS_STREAM: 'host:metrics',
    HOST_METRICS_MAXLEN: 8640,
    packHostMetrics: vi.fn(() => []),
  };
});

vi.mock('@squad/diag', () => ({
  createDiag: vi.fn(() => ({ emit: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('pino', () => {
  const pinoFn = vi.fn(() => harness.logger);
  (pinoFn as unknown as Record<string, unknown>).multistream = vi.fn(() => ({}));
  return { default: pinoFn, multistream: vi.fn(() => ({})) };
});

vi.mock('../src/lifecycle.js', () => ({
  emitStarted: vi.fn().mockResolvedValue(undefined),
  emitStopped: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/sampler.js', () => ({
  runSampler: vi.fn(() => harness.stopSampler),
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

  it('wires runtime callbacks and performs the complete cleanup sequence', async () => {
    expect(harness.redisOptions?.retryStrategy?.(4)).toBe(2000);

    harness.redisHandlers.get('error')?.(new Error('redis down') as never);
    harness.redisHandlers.get('reconnecting')?.(250 as never);
    harness.bridgeOnLog?.('bridge event', { requestId: 'r1' });
    harness.heartbeatOnError?.(new Error('heartbeat down'));
    harness.shutdownOptions?.onError?.(new Error('shutdown failed'));

    await harness.shutdownOptions?.cleanup('SIGTERM');

    expect(harness.stopSampler).toHaveBeenCalledOnce();
    expect(harness.stopHeartbeat).toHaveBeenCalledOnce();
    expect(harness.redisQuit).toHaveBeenCalledOnce();
    expect(harness.bridgeClose).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      { err: 'redis down' },
      'redis error (will retry)',
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      { err: 'shutdown failed' },
      'shutdown failed',
    );
  });
});
