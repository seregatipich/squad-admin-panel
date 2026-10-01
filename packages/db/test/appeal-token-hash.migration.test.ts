import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

describeIfDb('migration 0134 appeal token hash and api token index', () => {
  it('hashes stored tokens, keeps the previous release able to insert appeals and indexes api token hashes', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_appeal_hash', {
      throughMigration: '0118_clan_members_release_disbanded',
    });
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      await sql`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token)
        VALUES (76561190000000201, ${'x'.repeat(30)}, 'legacy-token-before')`;

      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

      const [backfilled] = await sql<{ hash: string; plain: string | null }[]>`
        SELECT tracking_token_hash AS hash, tracking_token AS plain
          FROM ban_appeals WHERE steam_id64 = 76561190000000201`;
      expect(backfilled).toEqual({ hash: sha256Hex('legacy-token-before'), plain: null });

      // The previous release only knows tracking_token: its INSERT must not
      // fail, and no plaintext is stored even after a rollback.
      await sql`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token)
        VALUES (76561190000000202, ${'y'.repeat(30)}, 'legacy-token-after')`;
      const [oldWriter] = await sql<{ hash: string; plain: string | null }[]>`
        SELECT tracking_token_hash AS hash, tracking_token AS plain
          FROM ban_appeals WHERE steam_id64 = 76561190000000202`;
      expect(oldWriter).toEqual({ hash: sha256Hex('legacy-token-after'), plain: null });

      // The new release writes only the hash.
      await sql`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token_hash)
        VALUES (76561190000000203, ${'z'.repeat(30)}, ${sha256Hex('fresh')})`;
      const [newWriter] = await sql<{ steam: string; plain: string | null }[]>`
        SELECT steam_id64::text AS steam, tracking_token AS plain
          FROM ban_appeals WHERE tracking_token_hash = ${sha256Hex('fresh')}`;
      expect(newWriter).toEqual({ steam: '76561190000000203', plain: null });

      const [tokenIndex] = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'player_api_tokens_token_hash_key'`;
      expect(tokenIndex?.indexdef).toContain('UNIQUE');
      expect(tokenIndex?.indexdef).toContain('(token_hash)');
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
