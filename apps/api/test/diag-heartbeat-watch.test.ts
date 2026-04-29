import type { Diag, DiagEvent } from '@squad/diag';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness } from './integration/harness.js';

let harness: IntegrationHarness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('heartbeat-watch plugin', () => {
  it('emits worker.heartbeat_lost exactly once after >30s outage', async () => {
    harness = await buildIntegrationApp();
    const { app, redis } = harness;
    const captured: DiagEvent[] = [];
    (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    for (const name of [
      'rcon',
      'log-ingest',
      'audit-archiver',
      'event-partition',
      'diag-flush',
      'metrics-sampler',
    ]) {
      await redis.del(`worker:heartbeat:${name}`);
    }

    await app.heartbeatWatchTick();
    expect(captured.filter((e) => e.kind === 'worker.heartbeat_lost')).toHaveLength(0);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      await app.heartbeatWatchTick();
    } finally {
      Date.now = realNow;
    }

    const lostEvents = captured.filter(
      (e) =>
        e.kind === 'worker.heartbeat_lost' && (e.payload as { worker?: string })?.worker === 'rcon',
    );
    expect(lostEvents).toHaveLength(1);
    expect(lostEvents[0]?.severity).toBe('error');
    expect(lostEvents[0]?.component).toBe('api');

    try {
      Date.now = () => realNow() + 60_000;
      await app.heartbeatWatchTick();
    } finally {
      Date.now = realNow;
    }
    const lostEvents2 = captured.filter(
      (e) =>
        e.kind === 'worker.heartbeat_lost' && (e.payload as { worker?: string })?.worker === 'rcon',
    );
    expect(lostEvents2).toHaveLength(1);
  });

  it('emits worker.heartbeat_recovered when the key reappears after reported outage', async () => {
    harness = await buildIntegrationApp();
    const { app, redis } = harness;
    const captured: DiagEvent[] = [];
    (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    for (const name of [
      'rcon',
      'log-ingest',
      'audit-archiver',
      'event-partition',
      'diag-flush',
      'metrics-sampler',
    ]) {
      await redis.del(`worker:heartbeat:${name}`);
    }

    await app.heartbeatWatchTick();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      await app.heartbeatWatchTick();
    } finally {
      Date.now = realNow;
    }

    await redis.set('worker:heartbeat:rcon', 'alive', 'EX', 30);
    await app.heartbeatWatchTick();

    const recovered = captured.filter(
      (e) =>
        e.kind === 'worker.heartbeat_recovered' &&
        (e.payload as { worker?: string })?.worker === 'rcon',
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.severity).toBe('info');
    expect(recovered[0]?.component).toBe('api');
  });

  it('does not emit worker.heartbeat_recovered without a prior reported outage', async () => {
    harness = await buildIntegrationApp();
    const { app, redis } = harness;
    const captured: DiagEvent[] = [];
    (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    await redis.set('worker:heartbeat:rcon', 'alive', 'EX', 30);
    await app.heartbeatWatchTick();

    expect(captured.filter((e) => e.kind === 'worker.heartbeat_recovered')).toHaveLength(0);
    expect(captured.filter((e) => e.kind === 'worker.heartbeat_lost')).toHaveLength(0);
  });
});
