import { describe, expect, it, vi } from 'vitest';
import { dropCutoverServers } from '../src/cutover.js';

describe('dropCutoverServers', () => {
  it('removes servers present in rnsquadjs:cutover-servers', async () => {
    const redis = { smismember: vi.fn().mockResolvedValue([0, 1]) } as never;
    const wanted = [
      { serverId: 'a', beaconPort: 1 },
      { serverId: 'b', beaconPort: 2 },
    ];
    const out = await dropCutoverServers(redis, wanted);
    expect(out.map((w) => w.serverId)).toEqual(['a']);
  });

  it('passes everything through on empty set', async () => {
    const redis = { smismember: vi.fn().mockResolvedValue([0]) } as never;
    const out = await dropCutoverServers(redis, [{ serverId: 'a', beaconPort: 1 }]);
    expect(out).toHaveLength(1);
  });
});
