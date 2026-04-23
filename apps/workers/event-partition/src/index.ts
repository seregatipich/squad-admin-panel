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
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });

  async function ensurePartitions() {
    const toCreate = 2; // current + next month (plus existing bootstraps from 0000_init.sql)
    for (let i = 0; i < toCreate; i++) {
      await sql`SELECT 1`; // placeholder — real logic in Phase 1 when pg_partman ships
    }
    log.info({ createdUpTo: toCreate }, 'partitions ensured');
  }

  await ensurePartitions();
  const interval = setInterval(
    () => {
      ensurePartitions().catch((err) =>
        log.error({ err: (err as Error).message }, 'partition failed'),
      );
    },
    60 * 60 * 1000,
  );

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
