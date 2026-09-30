import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 0120 adds pg_trgm GIN indexes for the `%q%` player-name searches (#40,
 * finding #1328). Without them every `LIKE '%…%'` over
 * `players.canonical_name_normalized` or `player_name_history.name_normalized`
 * scanned the whole table.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describeIfDb('0120 player name trigram indexes', () => {
  it.each([
    ['players', 'players_canonical_name_trgm_idx', 'canonical_name_normalized'],
    ['player_name_history', 'player_name_history_name_trgm_idx', 'name_normalized'],
  ])('%s has a GIN gin_trgm_ops index %s', async (table, index, column) => {
    const [row] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = ${table} AND indexname = ${index}
    `;
    expect(row?.indexdef).toContain('USING gin');
    expect(row?.indexdef).toContain(`${column} gin_trgm_ops`);
  });

  it('lets a leading-wildcard name search use the trigram index', async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const plan = await tx<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM players WHERE canonical_name_normalized LIKE '%abc%'
      `;
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'players_canonical_name_trgm_idx',
      );
    });
  });
});
