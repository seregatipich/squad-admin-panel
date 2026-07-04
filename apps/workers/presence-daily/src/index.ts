import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recentPresenceWindow, recomputeDailyPresence } from '@squad/db';
import { createDiag, type Diag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-presence-daily' },
});

const COMPONENT = 'worker-presence-daily';
const TICK_INTERVAL_MS = 60 * 60 * 1000;

export interface PresenceTickDeps {
  sql: postgres.Sql;
  diag: Diag;
  now?: Date;
}

export async function runPresenceDailyTick(deps: PresenceTickDeps): Promise<void> {
  const { sql, diag } = deps;
  const now = deps.now ?? new Date();
  const window = recentPresenceWindow(now);
  try {
    const rows = await recomputeDailyPresence(sql, { ...window, now });
    log.info({ ...window, rows }, 'presence daily recompute ok');
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.run_ok',
      severity: 'info',
      message: `recomputed ${window.fromDay}..${window.toDay}`,
      payload: { ...window, rows },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, ...window }, 'presence daily recompute failed');
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.run_failed',
      severity: 'error',
      message: `recompute failed: ${message}`,
      payload: { ...window },
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
        name: 'presence-daily',
        statusFn: () => 'idle',
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const diag: Diag = redis ? createDiag({ redis, log }) : { async emit() {} };

  await diag.emit({
    component: COMPONENT,
    kind: 'presence_daily.started',
    severity: 'info',
    message: 'presence-daily started',
    payload: { pid: process.pid },
  });

  await runPresenceDailyTick({ sql, diag });
  const interval = setInterval(() => {
    runPresenceDailyTick({ sql, diag }).catch((err) =>
      log.error({ err: (err as Error).message }, 'presence tick failed'),
    );
  }, TICK_INTERVAL_MS);

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
    await diag.emit({
      component: COMPONENT,
      kind: 'presence_daily.stopped',
      severity: 'info',
      message: `presence-daily received ${sig}`,
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
