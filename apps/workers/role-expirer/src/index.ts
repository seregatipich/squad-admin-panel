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
import { createRoleExpiryReminderDeps, runRoleExpiryReminderTick } from './reminders.js';
import { createRoleExpiryDeps, runRoleExpiryTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-role-expirer' },
});

const TICK_INTERVAL_MS = Number(process.env.ROLE_EXPIRER_INTERVAL_MS ?? 60_000);
/** Daily VIPSUB-4 reminder pass — window crossings fire at most once, so once a day is enough. */
const REMINDER_INTERVAL_MS = Number(process.env.ROLE_EXPIRY_REMINDER_INTERVAL_MS ?? 86_400_000);

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
    name: 'role-expirer',
    statusFn: () => 'running',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });
  const runtimeDeps = createRoleExpiryDeps(db, redis);

  await diag.emit({
    component: 'worker-role-expirer',
    kind: 'role_expirer.started',
    severity: 'info',
    message: 'role-expirer started',
    payload: { pid: process.pid },
  });

  async function tick(): Promise<void> {
    const result = await runRoleExpiryTick({ ...runtimeDeps, diag });
    log.info(result, 'role-expirer tick');
  }

  const reminderDeps = createRoleExpiryReminderDeps(db, redis);
  async function reminderTick(): Promise<void> {
    const result = await runRoleExpiryReminderTick({ ...reminderDeps, diag });
    log.info(result, 'role-expirer reminder tick');
  }

  await tick();
  const interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'role-expirer tick failed'));
  }, TICK_INTERVAL_MS);

  await reminderTick().catch((err) =>
    log.error({ err: (err as Error).message }, 'role-expirer reminder tick failed'),
  );
  const reminderInterval = setInterval(() => {
    reminderTick().catch((err) =>
      log.error({ err: (err as Error).message }, 'role-expirer reminder tick failed'),
    );
  }, REMINDER_INTERVAL_MS);

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    clearInterval(interval);
    clearInterval(reminderInterval);
    await diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.stopped',
      severity: 'info',
      message: `role-expirer received ${sig}`,
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
