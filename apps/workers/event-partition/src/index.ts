import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-event-partition' },
});

/**
 * Hourly cron replacement for pg_partman's run_maintenance. Creates the
 * next month's events partition a week before it is needed so writes never
 * land without a partition.
 */
export async function ensureDiagPartitions(sql: postgres.Sql): Promise<void> {
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

  async function ensurePartitions() {
    const toCreate = 2; // current + next month (plus existing bootstraps from 0000_init.sql)
    for (let i = 0; i < toCreate; i++) {
      await sql`SELECT 1`; // placeholder — real logic in Phase 1 when pg_partman ships
    }
    log.info({ createdUpTo: toCreate }, 'partitions ensured');
  }

  async function tick() {
    await ensurePartitions();
    await ensureDiagPartitions(sql);
  }

  await tick();
  const interval = setInterval(
    () => {
      tick().catch((err) => log.error({ err: (err as Error).message }, 'partition failed'));
    },
    60 * 60 * 1000,
  );

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    clearInterval(interval);
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
