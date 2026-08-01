import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recomputeBonusAccruals } from '../src/economy/accruals-aggregate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCRUALS_SQL = readFileSync(
  path.resolve(__dirname, '../sql/player-bonus-accruals.sql'),
  'utf-8',
);

const PLAYER_A = '0fa00a0a-0000-4000-8000-000000000001';
const PLAYER_B = '0fa00b0b-0000-4000-8000-000000000002';

const NOW = new Date('2026-07-26T12:00:00.000Z');

let sql: ReturnType<typeof postgres>;

async function seedTx(
  playerId: string,
  amount: number,
  type: string,
  createdAt: string,
  referenceId: string,
) {
  await sql`
    INSERT INTO bonus_transactions (player_id, amount, type, reference_type, reference_id, created_at)
    VALUES (${playerId}, ${amount}, ${type}, 'accruals-agg-test', ${referenceId}, ${createdAt}::timestamptz)
  `;
}

async function accrualRows() {
  return sql<{ player_id: string; accrued_30d: number }[]>`
    SELECT player_id, accrued_30d
    FROM player_bonus_accruals
    WHERE player_id = ANY(${[PLAYER_A, PLAYER_B]})
    ORDER BY player_id
  `;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  // The 0000_init.sql bootstrap only creates `bonus_transactions` partitions
  // for last month through +3 months (relative to whenever the test DB was
  // migrated), so this suite's fixed June/July 2026 fixture dates need their
  // own partitions explicitly ensured rather than relying on that window.
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS bonus_transactions_2026_06 PARTITION OF bonus_transactions FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')`,
  );
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS bonus_transactions_2026_07 PARTITION OF bonus_transactions FOR VALUES FROM ('2026-07-01') TO ('2026-08-01')`,
  );
  await sql.unsafe(ACCRUALS_SQL);
  for (const [id, name] of [
    [PLAYER_A, 'AccrualAlpha'],
    [PLAYER_B, 'AccrualBravo'],
  ]) {
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized)
      VALUES (${id}, ${name}, ${name.toLowerCase()})
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

async function resetOwnData() {
  await sql`DELETE FROM bonus_transactions WHERE player_id = ANY(${[PLAYER_A, PLAYER_B]})`;
  await sql`DELETE FROM player_bonus_accruals WHERE player_id = ANY(${[PLAYER_A, PLAYER_B]})`;
}

afterAll(async () => {
  if (!sql) return;
  await resetOwnData();
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B]})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await resetOwnData();
});

describeIfDb('recomputeBonusAccruals (ECON-5)', () => {
  it('sums only earn types inside the 30-day window', async () => {
    // Inside the window: 2026-06-26T12:00Z .. 2026-07-26T12:00Z.
    await seedTx(PLAYER_A, 100, 'earn_online', '2026-07-20T10:00:00.000Z', 'a-1');
    await seedTx(PLAYER_A, 40, 'earn_boost', '2026-07-01T10:00:00.000Z', 'a-2');
    await seedTx(PLAYER_A, 10, 'earn_seed', '2026-06-27T10:00:00.000Z', 'a-3');
    await seedTx(PLAYER_B, 55, 'earn_online', '2026-07-25T10:00:00.000Z', 'b-1');

    const count = await recomputeBonusAccruals(sql, NOW);
    expect(count).toBeGreaterThanOrEqual(2);

    const rows = await accrualRows();
    expect(rows.find((r) => r.player_id === PLAYER_A)?.accrued_30d).toBe(150);
    expect(rows.find((r) => r.player_id === PLAYER_B)?.accrued_30d).toBe(55);
  });

  it('excludes spend/adjust rows and older-than-window accruals', async () => {
    // Counted: one earn inside the window.
    await seedTx(PLAYER_A, 100, 'earn_online', '2026-07-10T00:00:00.000Z', 'a-in');
    // Not counted: earn strictly before now - 30d.
    await seedTx(PLAYER_A, 999, 'earn_online', '2026-06-01T00:00:00.000Z', 'a-old');
    // Not counted: spend/adjust are not accruals even inside the window.
    await seedTx(PLAYER_A, -50, 'spend', '2026-07-11T00:00:00.000Z', 'a-spend');
    await seedTx(PLAYER_A, 30, 'adjust', '2026-07-12T00:00:00.000Z', 'a-adj');
    // A player with only non-earn rows gets no aggregate row at all.
    await seedTx(PLAYER_B, -20, 'spend', '2026-07-13T00:00:00.000Z', 'b-spend');

    await recomputeBonusAccruals(sql, NOW);

    const rows = await accrualRows();
    expect(rows.find((r) => r.player_id === PLAYER_A)?.accrued_30d).toBe(100);
    expect(rows.find((r) => r.player_id === PLAYER_B)).toBeUndefined();
  });

  it('recompute is idempotent (second run yields identical rows)', async () => {
    await seedTx(PLAYER_A, 70, 'earn_online', '2026-07-15T00:00:00.000Z', 'a-1');
    await seedTx(PLAYER_B, 25, 'earn_seed', '2026-07-16T00:00:00.000Z', 'b-1');

    const first = await recomputeBonusAccruals(sql, NOW);
    const firstRows = await accrualRows();
    const second = await recomputeBonusAccruals(sql, NOW);
    const secondRows = await accrualRows();

    expect(second).toBe(first);
    expect(secondRows).toStrictEqual(firstRows);
    expect(firstRows.find((r) => r.player_id === PLAYER_A)?.accrued_30d).toBe(70);
    expect(firstRows.find((r) => r.player_id === PLAYER_B)?.accrued_30d).toBe(25);
  });
});
