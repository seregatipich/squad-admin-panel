import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiag, type Diag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-event-partition' },
});

const COMPONENT = 'worker-event-partition';

/**
 * Hourly cron replacement for pg_partman's run_maintenance on the
 * `diagnostic_events` table. Creates day partitions for yesterday through
 * two days ahead so writes never land without a partition, and drops
 * partitions older than 24 hours.
 */
export async function ensureDiagPartitions(sql: postgres.Sql): Promise<void> {
  // Partition bounds are computed in UTC; production Postgres MUST run with `TimeZone = 'UTC'` or equivalent for correctness.
  for (const offset of [-1, 0, 1, 2]) {
    const date = new Date(Date.now() + offset * 86_400_000);
    const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '');
    const partname = `diagnostic_events_${yyyymmdd}`;
    const from = date.toISOString().slice(0, 10);
    const to = new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${partname} PARTITION OF diagnostic_events FOR VALUES FROM ('${from}') TO ('${to}');`,
    );
    log.info({ partname }, 'ensured diag partition');
  }

  const cutoff = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const cutoffName = `diagnostic_events_${cutoff}`;
  const stale = (await sql`
    SELECT p.relname AS partname
    FROM pg_inherits
    JOIN pg_class p  ON p.oid = inhrelid
    JOIN pg_class pp ON pp.oid = inhparent
    WHERE pp.relname = 'diagnostic_events'
      AND p.relname < ${cutoffName}
  `) as unknown as { partname: string }[];
  for (const { partname } of stale) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${partname};`);
    log.info({ partname }, 'dropped stale diag partition');
  }
}

/** Months of history kept on the `events` table before a partition is dropped. */
const EVENTS_RETENTION_MONTHS = 24;

function monthPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `events_${year}_${month}`;
}

/**
 * Hourly cron replacement for pg_partman's run_maintenance on the `events`
 * table. Ensures the current + next month partitions exist (so writes never
 * land without a partition) and drops partitions entirely older than the
 * 24-month retention window. Mirrors ensureDiagPartitions() above exactly —
 * no pg_partman.
 */
export async function ensureMonthlyPartitions(sql: postgres.Sql): Promise<void> {
  // Partition bounds are computed in UTC; production Postgres MUST run with `TimeZone = 'UTC'` or equivalent for correctness.
  const now = new Date();
  for (const offset of [0, 1]) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
    const partname = monthPartitionName(monthStart);
    const from = monthStart.toISOString().slice(0, 10);
    const to = monthEnd.toISOString().slice(0, 10);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${partname} PARTITION OF events FOR VALUES FROM ('${from}') TO ('${to}');`,
    );
    log.info({ partname }, 'ensured events partition');
  }

  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - EVENTS_RETENTION_MONTHS, 1),
  );
  const cutoffName = monthPartitionName(cutoff);
  const stale = (await sql`
    SELECT p.relname AS partname
    FROM pg_inherits
    JOIN pg_class p  ON p.oid = inhrelid
    JOIN pg_class pp ON pp.oid = inhparent
    WHERE pp.relname = 'events'
      AND p.relname < ${cutoffName}
  `) as unknown as { partname: string }[];
  for (const { partname } of stale) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${partname};`);
    log.info({ partname }, 'dropped stale events partition');
  }
}

/**
 * Deletes `processed_events` markers older than the `events` retention window.
 * The table is an unpartitioned idempotency ledger nothing else prunes; a
 * marker is only meaningful while the event it guards can still be replayed,
 * which ends when its `events` partition is dropped (#62).
 */
export async function pruneProcessedEvents(sql: postgres.Sql): Promise<void> {
  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - EVENTS_RETENTION_MONTHS, 1),
  );
  const deleted = await sql`
    DELETE FROM processed_events WHERE processed_at < ${cutoff}
  `;
  if (deleted.count > 0) {
    log.info({ deleted: deleted.count }, 'pruned stale processed_events markers');
  }
}

function sessionPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `player_sessions_${year}_${month}`;
}

/**
 * Ensures the current + next month partitions of `player_sessions` exist.
 *
 * The initial partitions were created by the PRES-1 migration and run out on a
 * fixed calendar date; without this rotation the RCON presence projection
 * (`reconcilePlayerSessions`) starts failing with "no partition of relation
 * player_sessions found" the moment the window is passed — and with it the
 * match rosters and the whole dossier that are assembled from those sessions.
 *
 * Unlike {@link ensureMonthlyPartitions}, nothing is dropped: sessions are the
 * source of lifetime playtime and are not subject to the `events` retention
 * window.
 */
export async function ensurePlayerSessionPartitions(sql: postgres.Sql): Promise<void> {
  // Bounds are computed in UTC, matching ensureMonthlyPartitions above.
  const now = new Date();
  for (const offset of [0, 1]) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
    const partname = sessionPartitionName(monthStart);
    const from = monthStart.toISOString().slice(0, 10);
    const to = monthEnd.toISOString().slice(0, 10);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${partname} PARTITION OF player_sessions FOR VALUES FROM ('${from}') TO ('${to}');`,
    );
    log.info({ partname }, 'ensured player_sessions partition');
  }
}

/** A monthly RANGE-partitioned table that has a `<name>_default` DEFAULT partition. */
export interface DefaultBackedMonthlyTable {
  /** Parent table; its monthly partitions are named `<name>_YYYY_MM`. */
  name: string;
  /** The timestamptz partition key. */
  keyColumn: string;
}

/**
 * Monthly tables whose partitions exist only thanks to this worker. Their
 * migrations created a fixed window of months (the pg_partman rotation their
 * SQL files assumed was never installed), and migration 0117 gave each a
 * DEFAULT partition. Nothing is dropped: no retention policy has been adopted
 * for the chat log, the bonus ledger or the combat feed.
 */
export const DEFAULT_BACKED_MONTHLY_TABLES: readonly DefaultBackedMonthlyTable[] = [
  { name: 'chat_messages', keyColumn: 'sent_at' },
  { name: 'bonus_transactions', keyColumn: 'created_at' },
  { name: 'combat_events', keyColumn: 'occurred_at' },
];

/**
 * Ensures the current + next month partitions of a DEFAULT-backed monthly
 * table exist (issue #6).
 *
 * Without them `chat_messages` and `bonus_transactions` reject every insert
 * past the migration-created window ("no partition of relation … found for
 * row"), taking the chat log, bonus accruals, manual adjustments and VIP grants
 * down, and `combat_events` piles every row into its DEFAULT partition.
 *
 * Postgres refuses to add a partition whose range the DEFAULT partition still
 * holds rows for, so a missing month is built as a plain table, receives the
 * DEFAULT partition's rows for its range and is then attached — all in one
 * `DO` block, i.e. one transaction. The ACCESS EXCLUSIVE lock on the DEFAULT
 * partition keeps concurrent inserts from landing rows there between the move
 * and the attach; it is taken at most once per table per month. Migration
 * 0117 runs the same steps. Bounds are computed in UTC, matching
 * {@link ensureMonthlyPartitions}.
 *
 * @param sql - Connection to the panel database.
 * @param table - The table to rotate; its name and key column are trusted
 *   constants from {@link DEFAULT_BACKED_MONTHLY_TABLES}, interpolated into DDL.
 * @throws The Postgres error when creating or attaching a partition fails.
 */
export async function ensureDefaultBackedMonthlyPartitions(
  sql: postgres.Sql,
  table: DefaultBackedMonthlyTable,
): Promise<void> {
  const now = new Date();
  const defaultPartition = `${table.name}_default`;
  for (const offset of [0, 1]) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
    const partname = `${table.name}_${monthStart.getUTCFullYear()}_${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;
    const from = monthStart.toISOString().slice(0, 10);
    const to = monthEnd.toISOString().slice(0, 10);
    await sql.unsafe(`
      DO $$
      BEGIN
        IF to_regclass('${partname}') IS NOT NULL THEN
          RETURN;
        END IF;
        LOCK TABLE ${defaultPartition} IN ACCESS EXCLUSIVE MODE;
        CREATE TABLE ${partname} (LIKE ${table.name} INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
        WITH moved AS (
          DELETE FROM ${defaultPartition}
          WHERE ${table.keyColumn} >= '${from}' AND ${table.keyColumn} < '${to}'
          RETURNING *
        )
        INSERT INTO ${partname} SELECT * FROM moved;
        ALTER TABLE ${table.name} ATTACH PARTITION ${partname} FOR VALUES FROM ('${from}') TO ('${to}');
      END$$;
    `);
    log.info({ partname }, `ensured ${table.name} partition`);
  }
}

export interface PartitionTickDeps {
  sql: postgres.Sql;
  diag: Diag;
}

export async function runPartitionTick(deps: PartitionTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const failures: string[] = [];

  const results = await Promise.allSettled([
    ensureMonthlyPartitions(sql),
    pruneProcessedEvents(sql),
    ensureDiagPartitions(sql),
    ensurePlayerSessionPartitions(sql),
    ...DEFAULT_BACKED_MONTHLY_TABLES.map((table) =>
      ensureDefaultBackedMonthlyPartitions(sql, table),
    ),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      log.error({ err: message }, 'partition rotation tick rejected');
      failures.push(message);
    }
  }

  if (failures.length > 0) {
    await diag.emit({
      component: COMPONENT,
      kind: 'event_partition.run_failed',
      severity: 'error',
      message: `partition rotation failed: ${failures.join('; ')}`,
      payload: { failures },
    });
  } else {
    await diag.emit({
      component: COMPONENT,
      kind: 'event_partition.run_ok',
      severity: 'info',
      message: 'partition rotation ok',
      payload: {},
    });
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'event-partition',
        statusFn: () => 'idle',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      if (interval) clearInterval(interval);
      await diag.emit({
        component: COMPONENT,
        kind: 'event_partition.stopped',
        severity: 'info',
        message: `event-partition received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      await sql.end({ timeout: 5 });
      await redis?.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: COMPONENT,
    kind: 'event_partition.started',
    severity: 'info',
    message: 'event-partition started',
    payload: { pid: process.pid },
  });

  await runPartitionTick({ sql, diag });
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  interval = setInterval(
    () => {
      runPartitionTick({ sql, diag }).catch((err) =>
        log.error({ err: (err as Error).message }, 'partition failed'),
      );
    },
    60 * 60 * 1000,
  );
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((err) => {
    log.fatal({ err: (err as Error).message }, 'fatal');
    process.exit(1);
  });
}
