import { describe, expect, it, vi } from 'vitest';

describe('ensureDiagPartitions', () => {
  it('creates -1..+2 day partitions and drops partitions older than 24h', async () => {
    const calls: string[] = [];
    const stalePartitions = [
      { partname: 'diagnostic_events_20260424' },
      { partname: 'diagnostic_events_20260425' },
    ];

    const sql = Object.assign(
      ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
        const text = strings.join('?');
        if (text.includes('pg_inherits') || text.includes('pg_class')) {
          return Promise.resolve(stalePartitions);
        }
        return Promise.resolve([]);
      }) as never,
      {
        unsafe: vi.fn(async (text: string) => {
          calls.push(text);
        }),
      },
    ) as never;

    const { ensureDiagPartitions } = await import('../src/index.js');
    await ensureDiagPartitions(sql);

    const creates = calls.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'));
    const drops = calls.filter((s) => s.startsWith('DROP TABLE IF EXISTS'));
    expect(creates.length).toBe(4);
    expect(drops.length).toBe(2);
    expect(drops.some((d) => d.includes('diagnostic_events_20260424'))).toBe(true);
    expect(drops.some((d) => d.includes('diagnostic_events_20260425'))).toBe(true);
  });

  it('CREATE TABLE statements use diagnostic_events partition naming with YYYYMMDD suffix', async () => {
    const calls: string[] = [];
    const sql = Object.assign(
      ((_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve([])) as never,
      {
        unsafe: vi.fn(async (text: string) => {
          calls.push(text);
        }),
      },
    ) as never;

    const { ensureDiagPartitions } = await import('../src/index.js');
    await ensureDiagPartitions(sql);

    const creates = calls.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'));
    for (const stmt of creates) {
      expect(stmt).toMatch(
        /CREATE TABLE IF NOT EXISTS diagnostic_events_\d{8} PARTITION OF diagnostic_events FOR VALUES FROM \('\d{4}-\d{2}-\d{2}'\) TO \('\d{4}-\d{2}-\d{2}'\);/,
      );
    }
  });
});
