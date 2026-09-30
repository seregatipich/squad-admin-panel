import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const base64urlSha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

describeIfDb('migration 0119 appeal token hash', () => {
  it('backfills the hash and keeps the previous release able to insert and look up appeals', async () => {
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

      const [backfilled] = await sql<{ hash: string }[]>`
        SELECT tracking_token_hash AS hash FROM ban_appeals WHERE steam_id64 = 76561190000000201`;
      expect(backfilled?.hash).toBe(base64urlSha256('legacy-token-before'));

      // The previous release only knows tracking_token: its INSERT must not
      // fail and its lookup by the plaintext column must keep working.
      await sql`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token)
        VALUES (76561190000000202, ${'y'.repeat(30)}, 'legacy-token-after')`;
      const [oldLookup] = await sql<{ steam: string; hash: string }[]>`
        SELECT steam_id64::text AS steam, tracking_token_hash AS hash
          FROM ban_appeals WHERE tracking_token = 'legacy-token-after'`;
      expect(oldLookup?.steam).toBe('76561190000000202');
      expect(oldLookup?.hash).toBe(base64urlSha256('legacy-token-after'));

      // The new release writes only the hash.
      await sql`
        INSERT INTO ban_appeals (steam_id64, body, tracking_token_hash)
        VALUES (76561190000000203, ${'z'.repeat(30)}, ${base64urlSha256('fresh')})`;
      const [newLookup] = await sql<{ steam: string; plain: string | null }[]>`
        SELECT steam_id64::text AS steam, tracking_token AS plain
          FROM ban_appeals WHERE tracking_token_hash = ${base64urlSha256('fresh')}`;
      expect(newLookup).toEqual({ steam: '76561190000000203', plain: null });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
