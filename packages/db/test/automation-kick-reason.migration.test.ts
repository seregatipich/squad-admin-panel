import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createIsolatedPackageTestDatabase } from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL = path.resolve(__dirname, '../drizzle/0120_automation_kick_default_reason.sql');

describeIfDb('migration 0120 automation_kick_default_reason (#53)', () => {
  it('backfills a reason on blank-reason kick rules and leaves every other rule alone', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_kick_reason', {
      throughMigration: '0118_clan_members_release_disbanded',
    });
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      await sql`
        INSERT INTO automation_rules (name, condition_type, condition, action_type, action)
        VALUES
          ('empty', 'chat_keyword', '{"keyword":"x"}', 'kick', '{"reason":""}'),
          ('blank', 'chat_keyword', '{"keyword":"x"}', 'kick', '{"reason":"   "}'),
          ('missing', 'chat_keyword', '{"keyword":"x"}', 'kick', '{}'),
          ('kept', 'chat_keyword', '{"keyword":"x"}', 'kick', '{"reason":"afk"}'),
          ('warn', 'chat_keyword', '{"keyword":"x"}', 'warn', '{"message":""}')`;

      await sql.unsafe(readFileSync(MIGRATION_SQL, 'utf-8'));

      const rows = await sql<{ name: string; action: Record<string, unknown> }[]>`
        SELECT name, action FROM automation_rules ORDER BY name`;
      expect(Object.fromEntries(rows.map((r) => [r.name, r.action]))).toEqual({
        blank: { reason: 'Автоматический кик' },
        empty: { reason: 'Автоматический кик' },
        kept: { reason: 'afk' },
        missing: { reason: 'Автоматический кик' },
        warn: { message: '' },
      });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
