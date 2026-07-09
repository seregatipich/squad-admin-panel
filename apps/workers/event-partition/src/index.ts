import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiag, type Diag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
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

export interface PartitionTickDeps {
  sql: postgres.Sql;
  diag: Diag;
}

export async function runPartitionTick(deps: PartitionTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const failures: string[] = [];

  const results = await Promise.allSettled([
    ensureMonthlyPartitions(sql),
    ensureDiagPartitions(sql),
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

  await diag.emit({
    component: COMPONENT,
    kind: 'event_partition.started',
    severity: 'info',
    message: 'event-partition started',
    payload: { pid: process.pid },
  });

  await runPartitionTick({ sql, diag });
  const interval = setInterval(
    () => {
      runPartitionTick({ sql, diag }).catch((err) =>
        log.error({ err: (err as Error).message }, 'partition failed'),
      );
    },
    60 * 60 * 1000,
  );

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
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
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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
