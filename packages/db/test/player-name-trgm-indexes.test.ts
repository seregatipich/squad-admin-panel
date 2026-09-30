import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let pgsql: ReturnType<typeof postgres>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL, { onnotice: () => undefined });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

/**
 * Audit #117/#138 — the nickname searches run `LIKE '%q%'` over these two
 * columns; a btree index cannot serve a leading wildcard, so without a
 * trigram index every search was a sequential scan.
 */
describeIfDb('player-name trigram indexes (migration 0119)', () => {
  it.each([
    ['players', 'players_canonical_name_normalized_trgm_idx', 'canonical_name_normalized'],
    ['player_name_history', 'player_name_history_name_normalized_trgm_idx', 'name_normalized'],
  ])('%s has a GIN gin_trgm_ops index on the normalised name', async (table, index, column) => {
    const rows = await pgsql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = ${table} AND indexname = ${index}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('USING gin');
    expect(rows[0]?.indexdef).toContain(`${column} gin_trgm_ops`);
  });
});
