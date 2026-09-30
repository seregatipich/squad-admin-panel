import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { createDiag, type Diag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { requiredTickIntervalMs } from './env.js';
import { createRoleExpiryReminderDeps, runRoleExpiryReminderTick } from './reminders.js';
import { createSubscriptionRenewalDeps, runSubscriptionRenewalTick } from './renewal.js';
import { createRoleExpiryDeps, runRoleExpiryTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-role-expirer' },
});

const TICK_INTERVAL_MS = requiredTickIntervalMs(
  'ROLE_EXPIRER_INTERVAL_MS',
  process.env.ROLE_EXPIRER_INTERVAL_MS,
  60_000,
);
/** Daily VIPSUB-4 reminder pass — window crossings fire at most once, so once a day is enough. */
const REMINDER_INTERVAL_MS = requiredTickIntervalMs(
  'ROLE_EXPIRY_REMINDER_INTERVAL_MS',
  process.env.ROLE_EXPIRY_REMINDER_INTERVAL_MS,
  86_400_000,
);
/**
 * VIPSUB-5 subscription renewal pass. Hourly: a renewal is due on a date, not
 * at a second, and each pass charges real bonus points — an hour keeps the
 * billing punctual without hammering the ledger.
 */
const RENEWAL_INTERVAL_MS = requiredTickIntervalMs(
  'VIP_RENEWAL_INTERVAL_MS',
  process.env.VIP_RENEWAL_INTERVAL_MS,
  3_600_000,
);

/**
 * Wraps a tick function so an overlapping call (the previous tick still
 * running when the next `setInterval` fires — a slow query, a Postgres
 * hiccup) skips instead of running concurrently. Two overlapping
 * `renewalTick`s reading the same due subscription before either commits is
 * exactly the double-charge scenario `chargeRenewalTx`'s `dueAt` check now
 * also guards against at the database level (#984, #990) — this stops it
 * from happening as routinely in the first place.
 */
export function guardAgainstOverlap(tick: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } finally {
      inFlight = false;
    }
  };
}

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
  const tick = guardAgainstOverlap(async () => {
    const result = await runRoleExpiryTick({ ...runtimeDeps, diag });
    log.info(result, 'role-expirer tick');
  });

  const reminderDeps = createRoleExpiryReminderDeps(db, redis);
  const reminderTick = guardAgainstOverlap(async () => {
    const result = await runRoleExpiryReminderTick({ ...reminderDeps, diag });
    log.info(result, 'role-expirer reminder tick');
  });

  const renewalDeps = createSubscriptionRenewalDeps(db, redis);
  const renewalTick = guardAgainstOverlap(async () => {
    const result = await runSubscriptionRenewalTick({ ...renewalDeps, diag });
    log.info(result, 'role-expirer subscription renewal tick');
  });

  let interval: NodeJS.Timeout | null = null;
  let reminderInterval: NodeJS.Timeout | null = null;
  let renewalInterval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      if (interval) clearInterval(interval);
      if (reminderInterval) clearInterval(reminderInterval);
      if (renewalInterval) clearInterval(renewalInterval);
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
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: 'worker-role-expirer',
    kind: 'role_expirer.started',
    severity: 'info',
    message: 'role-expirer started',
    payload: { pid: process.pid },
  });
  await tick();
  await reminderTick().catch((err) =>
    log.error({ err: (err as Error).message }, 'role-expirer reminder tick failed'),
  );
  await renewalTick().catch((err) =>
    log.error({ err: (err as Error).message }, 'role-expirer renewal tick failed'),
  );
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;

  interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'role-expirer tick failed'));
  }, TICK_INTERVAL_MS);
  reminderInterval = setInterval(() => {
    reminderTick().catch((err) =>
      log.error({ err: (err as Error).message }, 'role-expirer reminder tick failed'),
    );
  }, REMINDER_INTERVAL_MS);
  renewalInterval = setInterval(() => {
    renewalTick().catch((err) =>
      log.error({ err: (err as Error).message }, 'role-expirer renewal tick failed'),
    );
  }, RENEWAL_INTERVAL_MS);
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
