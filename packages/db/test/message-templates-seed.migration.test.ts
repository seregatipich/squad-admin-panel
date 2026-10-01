import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from './helpers/describe-if.js';

/**
 * 0119 seeds the built-in message templates once (#40, finding #197), replacing
 * the per-GET `INSERT … ON CONFLICT DO NOTHING` that resurrected deleted
 * defaults. Each case runs inside a transaction that is rolled back, so the
 * shared test database keeps whatever templates it had.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_SQL = readFileSync(
  path.resolve(__dirname, '../drizzle/0119_message_templates_seed_once.sql'),
  'utf-8',
);
const DEFAULT_ID_PATTERN = '0195b000-0000-7000-8000-%';

class Rollback extends Error {}

let sql: ReturnType<typeof postgres>;

/** Runs `body` in a transaction that is always rolled back. */
async function inRolledBackTx(body: (tx: postgres.TransactionSql) => Promise<void>) {
  await expect(
    sql.begin(async (tx) => {
      await body(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describeIfDb('0119 message template seed', () => {
  it('inserts the 16 built-in defaults into an empty table, enabled and author-less', async () => {
    await inRolledBackTx(async (tx) => {
      await tx`DELETE FROM message_templates`;
      await tx.unsafe(SEED_SQL);
      const rows = await tx<{ locale: string; is_enabled: boolean; created_by: string | null }[]>`
        SELECT locale, is_enabled, created_by FROM message_templates
      `;
      expect(rows).toHaveLength(16);
      expect(rows.filter((r) => r.locale === 'en')).toHaveLength(8);
      expect(rows.filter((r) => r.locale === 'ru')).toHaveLength(8);
      expect(rows.every((r) => r.is_enabled && r.created_by === null)).toBe(true);
    });
  });

  it('is idempotent and never overwrites an edited default', async () => {
    await inRolledBackTx(async (tx) => {
      await tx`DELETE FROM message_templates`;
      await tx.unsafe(SEED_SQL);
      await tx`
        UPDATE message_templates SET body = 'edited', is_enabled = false
        WHERE id = '0195b000-0000-7000-8000-000000000001'
      `;
      await tx.unsafe(SEED_SQL);
      const [count] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM message_templates WHERE id::text LIKE ${DEFAULT_ID_PATTERN}
      `;
      expect(count?.n).toBe(16);
      const [edited] = await tx<{ body: string; is_enabled: boolean }[]>`
        SELECT body, is_enabled FROM message_templates
        WHERE id = '0195b000-0000-7000-8000-000000000001'
      `;
      expect(edited).toEqual({ body: 'edited', is_enabled: false });
    });
  });
});
