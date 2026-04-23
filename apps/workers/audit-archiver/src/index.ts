import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-audit-archiver' },
});

/**
 * Phase 0 stub. The archiver will export a verified hash-chain snapshot
 * of audit_log to restic on a daily schedule in Phase 1. For P0 it still
 * publishes a heartbeat so the panel's system-status card can see that
 * the worker is alive, not just its container running.
 */
async function main() {
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'audit-archiver',
        statusFn: () => 'idle (P1)',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  log.info('worker-audit-archiver idle — Phase 1 functionality deferred');
  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
