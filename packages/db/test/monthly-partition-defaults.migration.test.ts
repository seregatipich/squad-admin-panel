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
 * Issue #6: `chat_messages` (0025) and `bonus_transactions` (0026) had only the
 * monthly partitions their migrations created and no DEFAULT partition, so on
 * production every insert starts failing the first day past that window. The
 * fix migration must remove that risk on its own, before worker-event-partition
 * ever runs: DEFAULT partitions for both, plus the current month and three
 * months ahead for all three monthly tables — moving any rows `combat_events`
 * already parked in its DEFAULT partition for those months.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const PLAYER_STEAM_ID = '76561190000060602';
const TABLES = ['chat_messages', 'bonus_transactions', 'combat_events'] as const;

function monthStart(offsetMonths: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
}

function partitionName(table: string, date: Date): string {
  return `${table}_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

describeIfDb('migration 0117 monthly_partition_defaults', () => {
  it('gives an exhausted production window DEFAULT partitions and three months of look-ahead', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(
      DATABASE_URL,
      'db_partition_defaults',
      {
        throughMigration: '0116_events_appended_notify',
      },
    );
    const sql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      // Production's shape on the last day of its window: the bootstrap
      // partitions stop at the current month.
      for (const table of TABLES) {
        for (const offset of [1, 2, 3]) {
          await sql.unsafe(`DROP TABLE IF EXISTS ${partitionName(table, monthStart(offset))};`);
        }
      }
      const [player] = await sql<{ id: string }[]>`
        INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized)
        VALUES (${PLAYER_STEAM_ID}, 'Issue 6', 'issue 6')
        RETURNING id`;
      const [server] = await sql<{ id: string }[]>`
        INSERT INTO servers (id, display_name, slug)
        VALUES (gen_random_uuid(), 'Issue 6', 'db-partition-defaults')
        RETURNING id`;
      const parkedAt = new Date(monthStart(2).getTime() + 3 * 86_400_000).toISOString();
      await sql`
        INSERT INTO combat_events (event_type, server_id, occurred_at)
        VALUES ('death', ${server?.id as string}, ${parkedAt})`;
      await expect(
        sql`INSERT INTO chat_messages (player_id, server_id, sent_at, scope, message)
            VALUES (${player?.id as string}, ${server?.id as string}, ${monthStart(1).toISOString()}, 'all', 'x')`,
      ).rejects.toThrow(/no partition of relation "chat_messages" found for row/);

      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

      for (const table of TABLES) {
        const partitions = await sql<{ name: string; bound: string }[]>`
          SELECT p.relname AS name, pg_get_expr(p.relpartbound, p.oid) AS bound
          FROM pg_inherits
          JOIN pg_class p  ON p.oid = inhrelid
          JOIN pg_class pp ON pp.oid = inhparent
          WHERE pp.relname = ${table}`;
        const bounds = new Map(partitions.map((row) => [row.name, row.bound]));
        expect(bounds.get(`${table}_default`)).toBe('DEFAULT');
        for (const offset of [0, 1, 2, 3]) {
          expect(bounds.get(partitionName(table, monthStart(offset)))).toBe(
            `FOR VALUES FROM ('${monthStart(offset).toISOString().slice(0, 10)} 00:00:00+00') ` +
              `TO ('${monthStart(offset + 1)
                .toISOString()
                .slice(0, 10)} 00:00:00+00')`,
          );
        }
      }

      const [parked] = await sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM combat_events WHERE occurred_at = ${parkedAt}`;
      expect(parked?.part).toBe(partitionName('combat_events', monthStart(2)));

      // Inside the look-ahead a row lands in its month; beyond it, in DEFAULT
      // instead of failing the insert.
      const farFuture = monthStart(24).toISOString();
      await sql`
        INSERT INTO chat_messages (player_id, server_id, sent_at, scope, message)
        VALUES (${player?.id as string}, ${server?.id as string}, ${monthStart(1).toISOString()}, 'all', 'x'),
               (${player?.id as string}, ${server?.id as string}, ${farFuture}, 'all', 'y')`;
      await sql`
        INSERT INTO bonus_transactions (player_id, amount, type, created_at)
        VALUES (${player?.id as string}, 5, 'adjust', ${farFuture})`;
      const landed = await sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM chat_messages ORDER BY sent_at`;
      expect(landed.map((row) => row.part)).toEqual([
        partitionName('chat_messages', monthStart(1)),
        'chat_messages_default',
      ]);
      const [bonus] = await sql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM bonus_transactions WHERE created_at = ${farFuture}`;
      expect(bonus?.part).toBe('bonus_transactions_default');
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);

  it('is a no-op for partitions a fresh database already has', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      for (const table of TABLES) {
        const [row] = await sql<{ bound: string | null }[]>`
          SELECT pg_get_expr(p.relpartbound, p.oid) AS bound
          FROM pg_class p WHERE p.relname = ${`${table}_default`}`;
        expect(row?.bound).toBe('DEFAULT');
      }
      const [applied] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      const journalLength = (
        await import('../drizzle/meta/_journal.json', { with: { type: 'json' } })
      ).default.entries.length;
      expect(applied?.n).toBe(journalLength);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  });
});
