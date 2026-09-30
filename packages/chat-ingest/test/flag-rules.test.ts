import { describe, expect, it, vi } from 'vitest';
import { ChatFlagDetector } from '../src/index.js';

/**
 * A db stub for `ChatFlagDetector`'s rule query. `orderBy()` — where the query
 * ends — resolves on a later macrotask so concurrent callers genuinely overlap.
 */
function rulesDb(load: () => Promise<unknown[]>) {
  const chain: Record<string, unknown> = {
    orderBy: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return load();
    }),
  };
  for (const method of ['from', 'where']) chain[method] = vi.fn(() => chain);
  const select = vi.fn(() => chain);
  return { db: { select } as never, select };
}

describe('ChatFlagDetector', () => {
  it('shares one rule reload between concurrent detect() calls', async () => {
    const { db, select } = rulesDb(async () => [
      { id: 'rule-1', pattern: 'badword', patternType: 'word' },
    ]);
    const detector = new ChatFlagDetector(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => detector.detect(i % 2 ? 'badword here' : 'clean')),
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === 'rule-1')).toHaveLength(5);
  });

  it('reloads again after the TTL and after invalidate()', async () => {
    const { db, select } = rulesDb(async () => []);
    const detector = new ChatFlagDetector(db, 0);
    await detector.detect('a');
    await detector.detect('b');
    expect(select).toHaveBeenCalledTimes(2);

    const cached = rulesDb(async () => []);
    const long = new ChatFlagDetector(cached.db, 60_000);
    await long.detect('a');
    await long.detect('b');
    expect(cached.select).toHaveBeenCalledTimes(1);
    long.invalidate();
    await long.detect('c');
    expect(cached.select).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed reload: every waiter sees the error and the next call retries', async () => {
    let fail = true;
    const { db, select } = rulesDb(async () => {
      if (fail) throw new Error('db down');
      return [];
    });
    const detector = new ChatFlagDetector(db);

    const outcomes = await Promise.allSettled([detector.detect('a'), detector.detect('b')]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(select).toHaveBeenCalledTimes(1);

    fail = false;
    await expect(detector.detect('c')).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(2);
  });
});
