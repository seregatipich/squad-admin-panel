import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { createSteamRefreshDeps, runSteamRefreshTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-steam-refresh' },
});

const TICK_INTERVAL_MS = Number(process.env.STEAM_REFRESH_INTERVAL_MS ?? 60 * 60 * 1000);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 4, prepare: false });
  const db = drizzle(sql, { schema }) as DatabaseClient;
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (error: Error) =>
    log.warn({ error: error.message }, 'redis error (will retry)'),
  );
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const diag = createDiag({ redis, log });
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'steam-refresh',
    statusFn: () => (process.env.STEAM_API_KEY ? 'running' : 'disabled'),
    onError: (error) => log.warn({ error: error.message }, 'heartbeat publish failed'),
  });
  const deps = createSteamRefreshDeps(db, redis, process.env.STEAM_API_KEY ?? '');

  const tick = async (): Promise<void> => {
    const result = await runSteamRefreshTick({ ...deps, diag });
    log.info(result, 'steam-refresh tick');
  };

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (signal) => {
      log.info({ signal }, 'shutdown');
      if (interval) clearInterval(interval);
      await diag
        .emit({
          component: 'worker-steam-refresh',
          kind: 'steam_refresh.stopped',
          severity: 'info',
          message: `steam-refresh received ${signal}`,
          payload: { signal },
        })
        .catch(() => undefined);
      stopHeartbeat();
      await sql.end({ timeout: 5 });
      await redis.quit().catch(() => undefined);
    },
    onError: (error) => log.error({ error: error.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: 'worker-steam-refresh',
    kind: 'steam_refresh.started',
    severity: 'info',
    message: 'steam-refresh started',
    payload: { intervalMs: TICK_INTERVAL_MS, configured: Boolean(process.env.STEAM_API_KEY) },
  });
  await tick();
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;

  interval = setInterval(() => {
    tick().catch((error) =>
      log.error({ error: (error as Error).message }, 'steam-refresh tick failed'),
    );
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
  main().catch((error) => {
    log.fatal({ error: (error as Error).message }, 'fatal');
    process.exit(1);
  });
}
