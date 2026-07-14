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
import { createClanGuardDeps } from './deps.js';
import { runClanGuardTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-clan-guard' },
});

const TICK_INTERVAL_MS = Number(process.env.CLAN_GUARD_INTERVAL_MS ?? 120_000);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

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
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'clan-guard',
    statusFn: () => 'running',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });
  const runtimeDeps = createClanGuardDeps(db, redis);

  await diag.emit({
    component: 'worker-clan-guard',
    kind: 'clan_guard.started',
    severity: 'info',
    message: 'clan-guard started',
    payload: { pid: process.pid },
  });

  async function tick(): Promise<void> {
    const result = await runClanGuardTick({ ...runtimeDeps, diag });
    log.info(result, 'clan-guard tick');
  }

  await tick();
  const interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'clan-guard tick failed'));
  }, TICK_INTERVAL_MS);

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
    await diag.emit({
      component: 'worker-clan-guard',
      kind: 'clan_guard.stopped',
      severity: 'info',
      message: `clan-guard received ${sig}`,
      payload: { sig },
    });
    stopHeartbeat();
    await sql.end({ timeout: 5 });
    await redis.quit().catch(() => undefined);
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
