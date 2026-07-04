import { describe, expect, it, vi } from 'vitest';
import { filterCutoverServers, RNSQUADJS_CUTOVER_SET } from '../src/rnsquadjs.js';

describe('filterCutoverServers', () => {
  it('partitions ids by set membership with one SMISMEMBER call', async () => {
    const smismember = vi.fn().mockResolvedValue([1, 0]);
    const redis = { smismember } as never;
    const r = await filterCutoverServers(redis, ['a', 'b']);
    expect(smismember).toHaveBeenCalledWith(RNSQUADJS_CUTOVER_SET, 'a', 'b');
    expect(r.cutover).toEqual(['a']);
    expect(r.legacy).toEqual(['b']);
  });

  it('returns empty partitions for empty input without calling redis', async () => {
    const smismember = vi.fn();
    const r = await filterCutoverServers({ smismember } as never, []);
    expect(r).toEqual({ cutover: [], legacy: [] });
    expect(smismember).not.toHaveBeenCalled();
  });
});
