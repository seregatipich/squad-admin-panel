import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-backup' } });

async function main() {
  log.info('worker-backup idle — deferred to later phase');
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'backup',
        statusFn: () => 'idle (P2)',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
