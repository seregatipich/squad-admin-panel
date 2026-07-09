import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureMonthlyPartitions } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

function partitionName(date: Date): string {
  return `events_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStart(offsetMonths: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

let sql: ReturnType<typeof postgres>;

async function partitionExists(name: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM pg_inherits
    JOIN pg_class p  ON p.oid = inhrelid
    JOIN pg_class pp ON pp.oid = inhparent
    WHERE pp.relname = 'events'
      AND p.relname = ${name}
  `;
  return rows.length > 0;
}

async function createEventsPartition(name: string, from: Date, to: Date): Promise<void> {
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${isoDate(from)}') TO ('${isoDate(to)}');`,
  );
}

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  if (sql) await sql.end();
});

describeIfDb('ensureMonthlyPartitions against a real, migrated database', () => {
  it('creates the next-month events partition with correct UTC month bounds', async () => {
    const nextStart = monthStart(1);
    const nextEnd = monthStart(2);
    const nextName = partitionName(nextStart);
    await sql.unsafe(`DROP TABLE IF EXISTS ${nextName};`);
    expect(await partitionExists(nextName)).toBe(false);

    await ensureMonthlyPartitions(sql);

    expect(await partitionExists(nextName)).toBe(true);
    const [{ bound }] = (await sql`
      SELECT pg_get_expr(p.relpartbound, p.oid) AS bound
      FROM pg_class p
      JOIN pg_inherits i ON i.inhrelid = p.oid
      JOIN pg_class pp ON pp.oid = i.inhparent
      WHERE pp.relname = 'events' AND p.relname = ${nextName}
    `) as unknown as [{ bound: string }];
    expect(bound).toContain(isoDate(nextStart));
    expect(bound).toContain(isoDate(nextEnd));
  });

  it('creates the current-month events partition if missing', async () => {
    const currentStart = monthStart(0);
    const currentName = partitionName(currentStart);
    await sql.unsafe(`DROP TABLE IF EXISTS ${currentName};`);
    expect(await partitionExists(currentName)).toBe(false);

    await ensureMonthlyPartitions(sql);

    expect(await partitionExists(currentName)).toBe(true);
  });

  it('drops a pre-seeded partition older than the 24-month retention window', async () => {
    const staleStart = monthStart(-40);
    const staleEnd = monthStart(-39);
    const staleName = partitionName(staleStart);
    await createEventsPartition(staleName, staleStart, staleEnd);
    expect(await partitionExists(staleName)).toBe(true);

    await ensureMonthlyPartitions(sql);

    expect(await partitionExists(staleName)).toBe(false);
  });

  it('keeps a pre-seeded partition that is within the 24-month retention window', async () => {
    const withinStart = monthStart(-12);
    const withinEnd = monthStart(-11);
    const withinName = partitionName(withinStart);
    await createEventsPartition(withinName, withinStart, withinEnd);

    await ensureMonthlyPartitions(sql);

    expect(await partitionExists(withinName)).toBe(true);
  });
});
