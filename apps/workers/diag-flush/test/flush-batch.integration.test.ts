import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { flushBatch } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const sql = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function entry(id: string, ts: string): string[] {
  return [
    'id',
    id,
    'ts',
    ts,
    'component',
    'diag-flush-test',
    'severity',
    'info',
    'kind',
    'test.poison',
    'message',
    'integration',
  ];
}

describeIfDb('flushBatch against Postgres (#872)', () => {
  it('stores the good rows of a batch that holds a row with no partition', async () => {
    if (!sql) throw new Error('database not configured');
    const good = [randomUUID(), randomUUID()];
    const orphan = randomUUID();
    const now = new Date().toISOString();
    const xack = vi.fn().mockResolvedValue(3);

    await flushBatch({
      sql,
      redis: { xack } as never,
      group: 'g',
      stream: 'diag:queue',
      entries: [
        ['1-0', entry(good[0] as string, now)],
        // Long before any partition exists (e.g. an event buffered through a long outage).
        ['1-1', entry(orphan, '2001-01-01T00:00:00Z')],
        ['1-2', entry(good[1] as string, now)],
      ],
    });

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM diagnostic_events WHERE id IN ${sql([...good, orphan])}`;
    expect(rows.map((row) => row.id).sort()).toEqual([...good].sort());
    expect(xack).toHaveBeenCalledWith('diag:queue', 'g', '1-0', '1-1', '1-2');
  });
});
