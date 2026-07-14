import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag, type Diag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { createSeedScheduleDeps } from './deps.js';
import { runSeedScheduleTick } from './seed-schedule-tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-scheduler' },
});

const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

/**
 * `@squad/worker-scheduler`: currently hosts SEED-3's (#142) seed-schedule
 * execution tick (`runSeedScheduleTick`). AUTO-2 (#73), a generic scheduled-
 * job registry, is designated to absorb this package's role later; until
 * then this is a single-purpose interval worker, structured like
 * `apps/workers/role-expirer` (pure tick + deps + heartbeat/diag/shutdown).
 */
async function main() {
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 4, prepare: false });
  const db = drizzle(sql, { schema }) as DatabaseClient;
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const diag: Diag = createDiag({ redis, log });
  let lastTickAt: string | null = null;
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'scheduler',
    statusFn: () => (lastTickAt ? `running (last tick ${lastTickAt})` : 'starting'),
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });
  const runtimeDeps = createSeedScheduleDeps(db, redis);

  await diag.emit({
    component: 'worker-scheduler',
    kind: 'scheduler.started',
    severity: 'info',
    message: 'worker-scheduler started',
    payload: { pid: process.pid },
  });

  async function tick(): Promise<void> {
    const result = await runSeedScheduleTick({ ...runtimeDeps, diag });
    lastTickAt = new Date().toISOString();
    log.info(result, 'seed-schedule tick');
  }

  // Registered before the first tick (not after) so a SIGTERM/SIGINT that
  // arrives while that first tick is still in flight (e.g. a slow initial
  // DB connection) is still handled gracefully instead of falling through to
  // the platform default (immediate, non-zero-exit termination).
  let interval: NodeJS.Timeout | null = null;
  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    if (interval) clearInterval(interval);
    await diag.emit({
      component: 'worker-scheduler',
      kind: 'scheduler.stopped',
      severity: 'info',
      message: `worker-scheduler received ${sig}`,
      payload: { sig },
    });
    stopHeartbeat();
    await sql.end({ timeout: 5 });
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await tick();
  interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'seed-schedule tick failed'));
  }, TICK_INTERVAL_MS);
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
