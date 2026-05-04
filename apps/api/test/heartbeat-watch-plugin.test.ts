import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeatWatchPlugin } from '../src/plugins/heartbeat-watch.js';

function buildApp(pttlFn: (...args: unknown[]) => Promise<number>) {
  const diagEvents: Array<{ kind: string; severity: string; message: string }> = [];
  const app = Fastify();
  app.decorate('redis', { pttl: pttlFn });
  app.decorate('diag', {
    emit: vi.fn(async (ev: { kind: string; severity: string; message: string }) => {
      diagEvents.push(ev);
    }),
  });
  return { app, diagEvents };
}

let app: Awaited<ReturnType<typeof Fastify>>;
let diagEvents: Array<{ kind: string; severity: string; message: string }>;
let pttlFn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  pttlFn = vi.fn().mockResolvedValue(25000);
  const harness = buildApp(pttlFn);
  app = harness.app;
  diagEvents = harness.diagEvents;
  await app.register(heartbeatWatchPlugin);
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('heartbeat-watch plugin', () => {
  it('decorates app with heartbeatWatchTick', () => {
    expect(typeof app.heartbeatWatchTick).toBe('function');
  });

  it('does not emit when all workers have live heartbeats', async () => {
    await app.heartbeatWatchTick();
    expect(diagEvents).toHaveLength(0);
  });

  it('does not emit on first detection of missing heartbeat (within threshold)', async () => {
    pttlFn.mockResolvedValue(-2);
    await app.heartbeatWatchTick();
    expect(diagEvents).toHaveLength(0);
  });

  it('emits heartbeat_lost after threshold exceeded', async () => {
    pttlFn.mockResolvedValue(-2);
    await app.heartbeatWatchTick();
    await vi.advanceTimersByTimeAsync(31_000);
    await app.heartbeatWatchTick();
    const lostEvents = diagEvents.filter((e) => e.kind === 'worker.heartbeat_lost');
    expect(lostEvents.length).toBeGreaterThan(0);
    expect(lostEvents[0].severity).toBe('error');
  });

  it('emits heartbeat_recovered when worker comes back', async () => {
    pttlFn.mockResolvedValue(-2);
    await app.heartbeatWatchTick();
    await vi.advanceTimersByTimeAsync(31_000);
    await app.heartbeatWatchTick();

    pttlFn.mockResolvedValue(25000);
    await app.heartbeatWatchTick();
    const recovered = diagEvents.filter((e) => e.kind === 'worker.heartbeat_recovered');
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered[0].severity).toBe('info');
  });

  it('does not re-emit heartbeat_lost for already-reported workers', async () => {
    pttlFn.mockResolvedValue(-1);
    await app.heartbeatWatchTick();
    vi.advanceTimersByTime(31_000);
    await app.heartbeatWatchTick();
    const countAfterFirst = diagEvents.filter((e) => e.kind === 'worker.heartbeat_lost').length;

    vi.advanceTimersByTime(31_000);
    await app.heartbeatWatchTick();
    const countAfterSecond = diagEvents.filter((e) => e.kind === 'worker.heartbeat_lost').length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('handles redis errors gracefully without throwing', async () => {
    pttlFn.mockRejectedValue(new Error('connection lost'));
    await expect(app.heartbeatWatchTick()).resolves.toBeUndefined();
  });
});
