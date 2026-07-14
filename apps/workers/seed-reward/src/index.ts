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
import { createSeedRewardDeps, runSeedRewardTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-seed-reward' },
});

const TICK_INTERVAL_MS = Number(process.env.SEED_REWARD_INTERVAL_MS ?? 86_400_000);

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
  redis.on('error', (error: Error) =>
    log.warn({ error: error.message }, 'redis error (will retry)'),
  );
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const diag: Diag = createDiag({ redis, log });
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'seed-reward',
    statusFn: () => 'running',
    onError: (error) => log.warn({ error: error.message }, 'heartbeat publish failed'),
  });
  const runtimeDeps = createSeedRewardDeps(db, redis);

  await diag.emit({
    component: 'worker-seed-reward',
    kind: 'seed_reward.started',
    severity: 'info',
    message: 'seed-reward started',
    payload: { pid: process.pid },
  });

  async function tick(): Promise<void> {
    const result = await runSeedRewardTick({ ...runtimeDeps, diag });
    log.info(result, 'seed-reward tick');
  }

  await tick();
  const interval = setInterval(() => {
    tick().catch((error) =>
      log.error({ error: (error as Error).message }, 'seed-reward tick failed'),
    );
  }, TICK_INTERVAL_MS);

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info({ signal }, 'shutdown');
    clearInterval(interval);
    await diag.emit({
      component: 'worker-seed-reward',
      kind: 'seed_reward.stopped',
      severity: 'info',
      message: `seed-reward received ${signal}`,
      payload: { signal },
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
  main().catch((error) => {
    log.fatal({ error: (error as Error).message }, 'fatal');
    process.exit(1);
  });
}
