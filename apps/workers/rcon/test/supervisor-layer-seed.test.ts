import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RconSupervisor, type Target } from '../src/supervisor.js';

interface LayerSeedLookup {
  resolveLayerIsSeed(name: string): Promise<boolean | null>;
}

const target: Target = { serverId: 'srv-layer', host: '127.0.0.1', port: 29100, password: 'pw' };

/** Builds the per-server supervisor through the public reconcile path, backed by a fake catalog. */
async function makeLookup(limit: ReturnType<typeof vi.fn>) {
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  const supervisor = new RconSupervisor({
    db: db as never,
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
      publish: vi.fn().mockResolvedValue(0),
      xadd: vi.fn().mockResolvedValue('0-0'),
    } as never,
    log: log as never,
    diag: { emit: vi.fn().mockResolvedValue(undefined) } as never,
  });
  await supervisor.reconcile([target]);
  const children = (supervisor as unknown as { supervisors: Map<string, LayerSeedLookup> })
    .supervisors;
  return { supervisor, lookup: children.get(target.serverId) as LayerSeedLookup };
}

describe('PerServerSupervisor layer is_seed lookup (#985)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not cache a failed catalog query, so the next lookup recovers', async () => {
    const limit = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue([{ isSeed: true }]);
    const { supervisor, lookup } = await makeLookup(limit);

    await expect(lookup.resolveLayerIsSeed('Jensen Training')).resolves.toBeNull();
    await expect(lookup.resolveLayerIsSeed('Jensen Training')).resolves.toBe(true);
    expect(limit).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it('caches a successful answer, including a layer missing from the catalog', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const { supervisor, lookup } = await makeLookup(limit);

    await expect(lookup.resolveLayerIsSeed('Unknown')).resolves.toBeNull();
    await expect(lookup.resolveLayerIsSeed('Unknown')).resolves.toBeNull();
    expect(limit).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });
});
