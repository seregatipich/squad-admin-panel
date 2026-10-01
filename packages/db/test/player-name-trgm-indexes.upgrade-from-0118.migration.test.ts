import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

/**
 * #69 (finding #180): name search runs `LIKE '%q%'`, which no btree index can
 * serve. Migration 0126 adds pg_trgm GIN indexes on the two searched columns;
 * this checks they exist after upgrading from 0118 and that the planner can use
 * them for an unanchored, escaped LIKE.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describeIfDb('migration 0126 player_name_trgm_indexes', () => {
  it('adds GIN trigram indexes that serve an unanchored LIKE on player names', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_name_trgm', {
      throughMigration: '0118_clan_members_release_disbanded',
    });
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

      const indexes = await sql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN (
          'players_canonical_name_normalized_trgm_idx',
          'player_name_history_name_normalized_trgm_idx'
        )
        ORDER BY indexname`;
      expect(indexes.map((row) => row.indexname)).toEqual([
        'player_name_history_name_normalized_trgm_idx',
        'players_canonical_name_normalized_trgm_idx',
      ]);
      for (const row of indexes) expect(row.indexdef).toContain('gin_trgm_ops');

      await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        const plan = await tx<{ 'QUERY PLAN': string }[]>`
          EXPLAIN SELECT id FROM players WHERE canonical_name_normalized LIKE ${'%al\\_ph%'}`;
        expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
          'players_canonical_name_normalized_trgm_idx',
        );
      });
    } finally {
      await sql.end({ timeout: 5 });
      await isolated.drop();
    }
  }, 120_000);
});
