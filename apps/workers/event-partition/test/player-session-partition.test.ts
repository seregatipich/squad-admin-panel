import { describe, expect, it, vi } from 'vitest';

/**
 * PRES-1 partitions were created by migration through a fixed calendar month.
 * Once the RCON presence projection started writing them, an unrotated
 * `player_sessions` would begin rejecting inserts on the first day past that
 * window — and match rosters and the dossier are assembled from those rows.
 */
function fakeSql(calls: string[]) {
  return Object.assign(
    ((_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve([])) as never,
    {
      unsafe: vi.fn(async (text: string) => {
        calls.push(text);
      }),
    },
  ) as never;
}

describe('ensurePlayerSessionPartitions', () => {
  it('creates the current and next month partitions of player_sessions', async () => {
    const calls: string[] = [];
    const { ensurePlayerSessionPartitions } = await import('../src/index.js');

    await ensurePlayerSessionPartitions(fakeSql(calls));

    const creates = calls.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'));
    expect(creates).toHaveLength(2);
    for (const stmt of creates) {
      expect(stmt).toMatch(/player_sessions_\d{4}_\d{2} PARTITION OF player_sessions/);
      expect(stmt).toMatch(/FOR VALUES FROM \('\d{4}-\d{2}-01'\) TO \('\d{4}-\d{2}-01'\)/);
    }

    const now = new Date();
    const thisMonth = `player_sessions_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const nextMonth = `player_sessions_${next.getUTCFullYear()}_${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(creates.some((s) => s.includes(thisMonth))).toBe(true);
    expect(creates.some((s) => s.includes(nextMonth))).toBe(true);
  });

  it('never drops a player_sessions partition — sessions are lifetime playtime history', async () => {
    const calls: string[] = [];
    const { ensurePlayerSessionPartitions } = await import('../src/index.js');

    await ensurePlayerSessionPartitions(fakeSql(calls));

    expect(calls.filter((s) => s.startsWith('DROP TABLE'))).toHaveLength(0);
  });

  it('is included in the partition tick, so the rotation actually runs in production', async () => {
    const calls: string[] = [];
    const { runPartitionTick } = await import('../src/index.js');
    const diag = { emit: vi.fn(async () => undefined) };

    await runPartitionTick({ sql: fakeSql(calls), diag: diag as never });

    expect(calls.some((s) => s.includes('PARTITION OF player_sessions'))).toBe(true);
  });
});
