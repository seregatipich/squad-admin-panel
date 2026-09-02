import { fileURLToPath } from 'node:url';
import { getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { ADMINS_CFG_RELOAD_OUTCOMES, adminsCfgSyncOutbox } from '../src/schema/index.js';
import { createIsolatedPackageTestDatabase } from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle/', import.meta.url));

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL);
  db = drizzle(pgsql, { schema });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

describe('admins_cfg_sync_outbox schema', () => {
  it('allowlists terminal and retryable reload outcomes including removed servers', () => {
    expect(ADMINS_CFG_RELOAD_OUTCOMES).toEqual([
      'confirmed',
      'file_ready_for_restart',
      'server_removed',
      'unavailable',
      'rejected',
      'timeout',
      'invalid_result',
    ]);
  });

  it('exposes delivery correlation and application-result fields', () => {
    expect(Object.keys(getTableColumns(adminsCfgSyncOutbox)).sort()).toEqual([
      'appliedAt',
      'correlationId',
      'createdAt',
      'id',
      'lastError',
      'payload',
      'relayedAt',
      'reloadOutcome',
      'serverId',
      'streamId',
    ]);
  });
});

describeIfDb('migration 0109 admins_cfg_sync_outbox delivery contract', () => {
  it('adds nullable delivery correlation and application-result columns', async () => {
    const rows = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'admins_cfg_sync_outbox'
        AND column_name IN ('correlation_id', 'applied_at', 'last_error', 'reload_outcome')
      ORDER BY column_name
    `)) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>;

    expect(rows).toEqual([
      { column_name: 'applied_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'correlation_id', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'last_error', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'reload_outcome', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('indexes only correlated rows', async () => {
    const rows = (await db.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'admins_cfg_sync_outbox'
        AND indexname = 'admins_cfg_sync_outbox_correlation_idx'
    `)) as unknown as Array<{ indexdef: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('(correlation_id)');
    expect(rows[0]?.indexdef).toContain('WHERE (correlation_id IS NOT NULL)');
  });

  it('upgrades a database whose recorded migration chain ends at the original 0108', async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_outbox_upgrade');
    const upgradeSql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
      await upgradeSql.unsafe('DROP INDEX IF EXISTS admins_cfg_sync_outbox_correlation_idx');
      await upgradeSql.unsafe(
        'ALTER TABLE admins_cfg_sync_outbox DROP COLUMN IF EXISTS correlation_id, DROP COLUMN IF EXISTS applied_at, DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS reload_outcome',
      );
      await upgradeSql.unsafe(
        'DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)',
      );

      await migrate(drizzle(upgradeSql), { migrationsFolder: MIGRATIONS_FOLDER });

      const [result] = await upgradeSql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'admins_cfg_sync_outbox'
          AND column_name IN ('correlation_id', 'applied_at', 'last_error', 'reload_outcome')`;
      expect(result?.count).toBe(4);
    } finally {
      await upgradeSql.end({ timeout: 5 }).catch(() => undefined);
      await isolated.drop();
    }
  }, 120_000);
});
