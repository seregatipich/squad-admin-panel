import { getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueAdminsCfgSyncForAllServers,
  getAdminsCfgSyncOutboxState,
  markAdminsCfgSyncApplied,
  markAdminsCfgSyncFailed,
} from '../src/admins-cfg-outbox.js';
import * as schema from '../src/schema/index.js';
import { ADMINS_CFG_RELOAD_OUTCOMES, adminsCfgSyncOutbox, servers } from '../src/schema/index.js';
import {
  createIsolatedPackageTestDatabase,
  MIGRATIONS_FOLDER,
} from './helpers/isolated-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let serverId: string;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL);
  db = drizzle(pgsql, { schema });
});

beforeEach(async () => {
  if (!DATABASE_URL) return;
  await db.delete(adminsCfgSyncOutbox);
  serverId = uuidv7();
  await db.insert(servers).values({
    id: serverId,
    displayName: `outbox-apply-${serverId}`,
    slug: `outbox-apply-${serverId}`,
  });
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
    const isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'db_outbox_upgrade', {
      throughMigration: '0108_vip_delivery_status',
    });
    const upgradeSql = postgres(isolated.url, { max: 1, onnotice: () => undefined });
    try {
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

describeIfDb('admins_cfg_sync_outbox application state', () => {
  async function insertOutbox(): Promise<string> {
    const [row] = await db
      .insert(adminsCfgSyncOutbox)
      .values({ serverId, payload: { reason: 'test' } })
      .returning({ id: adminsCfgSyncOutbox.id });
    if (!row) throw new Error('outbox fixture was not inserted');
    return row.id;
  }

  it('atomically marks a pending row applied and keeps the first terminal outcome', async () => {
    const id = await insertOutbox();

    const [first, second] = await Promise.all([
      markAdminsCfgSyncApplied(db, id, 'confirmed'),
      markAdminsCfgSyncApplied(db, id, 'file_ready_for_restart'),
    ]);
    const stored = await getAdminsCfgSyncOutboxState(db, id);

    expect(first?.appliedAt ?? second?.appliedAt).toBeInstanceOf(Date);
    expect(stored?.appliedAt).toBeInstanceOf(Date);
    expect(['confirmed', 'file_ready_for_restart']).toContain(stored?.reloadOutcome);
    expect(first?.reloadOutcome).toBe(stored?.reloadOutcome);
    expect(second?.reloadOutcome).toBe(stored?.reloadOutcome);
    expect(stored?.lastError).toBeNull();
  });

  it('stores only an allowlisted failure and never clears an already applied row', async () => {
    const id = await insertOutbox();

    await expect(markAdminsCfgSyncFailed(db, id, 'raw bridge secret')).rejects.toThrow(
      'invalid admins cfg sync failure code',
    );
    expect(await markAdminsCfgSyncFailed(db, id, 'timeout')).toMatchObject({
      appliedAt: null,
      lastError: 'timeout',
      reloadOutcome: 'timeout',
    });

    const applied = await markAdminsCfgSyncApplied(db, id, 'confirmed');
    expect(applied).toMatchObject({ lastError: null, reloadOutcome: 'confirmed' });
    expect(await markAdminsCfgSyncFailed(db, id, 'rejected')).toMatchObject({
      lastError: null,
      reloadOutcome: 'confirmed',
    });
  });

  it('rejects retry-only outcomes on the terminal helper', async () => {
    const id = await insertOutbox();
    await expect(markAdminsCfgSyncApplied(db, id, 'timeout')).rejects.toThrow(
      'invalid admins cfg sync applied outcome',
    );
  });
});

describeIfDb('enqueueAdminsCfgSyncForAllServers and external servers', () => {
  it('fans out only to panel-hosted (container) servers', async () => {
    const externalId = uuidv7();
    await db.insert(servers).values({
      id: externalId,
      displayName: `outbox-external-${externalId}`,
      slug: `outbox-external-${externalId}`,
      status: 'running',
      runtime: 'external',
    });
    try {
      const { enqueued } = await db.transaction((tx) =>
        enqueueAdminsCfgSyncForAllServers(tx, { reason: 'test.external-skip' }),
      );
      const rows = await db
        .select({ serverId: adminsCfgSyncOutbox.serverId })
        .from(adminsCfgSyncOutbox);
      const targets = new Set(rows.map((r) => r.serverId));
      expect(enqueued).toBe(rows.length);
      expect(targets.has(serverId)).toBe(true);
      expect(targets.has(externalId)).toBe(false);
    } finally {
      await db.delete(adminsCfgSyncOutbox);
      await db.delete(servers).where(sql`id = ${externalId}::uuid`);
    }
  });
});
