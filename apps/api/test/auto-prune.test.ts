import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { fireAutoPrune } from '../src/lib/auto-prune.js';

function makeApp(overrides: {
  pruneResult?: { exit_code: number; reclaimed_bytes: number; reclaimed_human: string };
  pruneError?: Error;
  auditError?: Error;
}) {
  const valuesStub = vi.fn(async () => {
    if (overrides.auditError) throw overrides.auditError;
  });

  const closeStub = vi.fn(async () => undefined);

  const pruneStub = vi.fn(async () => {
    if (overrides.pruneError) throw overrides.pruneError;
    return (
      overrides.pruneResult ?? { exit_code: 0, reclaimed_bytes: 1024, reclaimed_human: '1 KiB' }
    );
  });

  const app = {
    makeBridgeClient: vi.fn(() => ({ dockerPrune: pruneStub, close: closeStub })),
    log: { info: vi.fn(), warn: vi.fn() },
    db: { insert: vi.fn().mockReturnValue({ values: valuesStub }) },
  } as unknown as FastifyInstance;

  return { app, pruneStub, closeStub, valuesStub };
}

function waitForSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drainAsync(): Promise<void> {
  await waitForSetImmediate();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('fireAutoPrune', () => {
  it('calls dockerPrune and writes an audit entry on success', async () => {
    const { app, pruneStub, valuesStub } = makeApp({});
    fireAutoPrune(app, 'server-delete', null, null);
    await drainAsync();
    expect(pruneStub).toHaveBeenCalledOnce();
    expect(valuesStub).toHaveBeenCalledOnce();
  });

  it('closes the bridge client after prune', async () => {
    const { app, closeStub } = makeApp({});
    fireAutoPrune(app, 'server-delete', null, null);
    await drainAsync();
    expect(closeStub).toHaveBeenCalledOnce();
  });

  it('logs a warning and still writes audit when dockerPrune throws', async () => {
    const { app, valuesStub } = makeApp({ pruneError: new Error('prune failed') });
    fireAutoPrune(app, 'server-delete', null, '10.0.0.1');
    await drainAsync();
    expect((app.log.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(valuesStub).toHaveBeenCalledOnce();
  });

  it('does not throw when both prune and audit fail', async () => {
    const { app } = makeApp({
      pruneError: new Error('prune error'),
      auditError: new Error('audit error'),
    });
    fireAutoPrune(app, 'server-delete', null, null);
    await drainAsync();
    expect((app.log.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('uses steam actor when actorPlayerId is provided', async () => {
    const { app, valuesStub } = makeApp({});
    fireAutoPrune(app, 'server-delete', 'test-player-001', '10.0.0.2');
    await drainAsync();
    const call = valuesStub.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.actorKind).toBe('steam');
    expect(call.actorPlayerId).toBe('test-player-001');
  });

  it('uses system actor when actorPlayerId is null', async () => {
    const { app, valuesStub } = makeApp({});
    fireAutoPrune(app, 'server-delete', null, null);
    await drainAsync();
    const call = valuesStub.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.actorKind).toBe('system');
    expect(call.actorSystemLabel).toBe('auto-prune');
  });
});
