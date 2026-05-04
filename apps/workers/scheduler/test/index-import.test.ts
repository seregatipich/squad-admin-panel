import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));
vi.mock('@squad/shared-config', () => ({
  startHeartbeat: vi.fn(() => vi.fn()),
}));
vi.mock('pino', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { default: vi.fn(() => logger) };
});

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterAll(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('scheduler index', () => {
  it('is importable without throwing', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
