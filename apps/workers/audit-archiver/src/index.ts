import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiag, type Diag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-audit-archiver' },
});

const COMPONENT = 'worker-audit-archiver';

/**
 * Phase 0 stub. The archiver will export a verified hash-chain snapshot
 * of audit_log to restic on a daily schedule in Phase 1. For P0 it still
 * publishes a heartbeat so the panel's system-status card can see that
 * the worker is alive, not just its container running. It deliberately
 * emits no "run ok" diagnostics: nothing is archived yet, so reporting a
 * successful cycle would be a false signal.
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

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  log.info('worker-audit-archiver idle — Phase 1 functionality deferred');

  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      await diag.emit({
        component: COMPONENT,
        kind: 'audit_archiver.stopped',
        severity: 'info',
        message: `audit-archiver received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      await redis?.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: COMPONENT,
    kind: 'audit_archiver.started',
    severity: 'info',
    message: 'audit-archiver started',
    payload: { pid: process.pid },
  });
  await shutdown.markReady();
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
