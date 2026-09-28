import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { createDiag } from '@squad/diag';
import { createGracefulShutdownController, startHeartbeat } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { runManualQueueLoop } from './manual-queue.js';
import { createSyncSourceDeps, syncSource } from './sync-source.js';
import type { DueSource } from './tick.js';
import { type BackoffMap, createTickDeps, runBanSyncTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-ban-sync' },
});

const TICK_INTERVAL_MS = Number(process.env.BAN_SYNC_INTERVAL_MS ?? 60_000);
const MANUAL_BLOCK_MS = 5_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function loadSourceById(db: DatabaseClient, sourceId: string): Promise<DueSource | null> {
  const rows = await db
    .select()
    .from(schema.externalBanSources)
    .where(eq(schema.externalBanSources.id, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    format: row.format,
    authHeaderEncrypted: row.authHeaderEncrypted,
    parserConfig: row.parserConfig as Record<string, unknown>,
    consecutiveFailures: row.consecutiveFailures,
    lastSyncAt: row.lastSyncAt,
    pollIntervalMinutes: row.pollIntervalMinutes,
  };
}

async function main() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const redisUrl = requiredEnv('REDIS_URL');
  const encryptionKey = requiredEnv('APP_ENCRYPTION_KEY');

  const sql = postgres(databaseUrl, { max: 4, prepare: false });
  const db = drizzle(sql, { schema }) as DatabaseClient;
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));
  // The manual-queue read holds its connection for up to MANUAL_BLOCK_MS, so it
  // gets one of its own: heartbeat and diag writes never queue behind it, and
  // shutdown can end the read by closing that connection instead of waiting
  // the block out.
  const manualRedis = redis.duplicate();
  manualRedis.on('error', (err: Error) =>
    log.warn({ err: err.message }, 'manual-queue redis error (will retry)'),
  );

  const diag: Diag = createDiag({ redis, log });
  const syncSourceDeps = createSyncSourceDeps(db, redis, diag, encryptionKey, log);
  const backoff: BackoffMap = new Map();
  // Shared by the scheduled tick and the manual queue so one source is never
  // synced twice at once (#853).
  const inFlight = new Set<string>();
  let stopped = false;
  const tickDeps = createTickDeps(db, syncSourceDeps, backoff, inFlight, () => stopped);

  // Heartbeat starts before any DB-dependent work below, so a slow/
  // unreachable Postgres never delays the liveness signal (mirrors
  // apps/workers/role-expirer/src/index.ts).
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'ban-sync',
    statusFn: () => 'running',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  let interval: NodeJS.Timeout | null = null;
  let runningTick: Promise<void> | null = null;
  let manualLoop: Promise<void> = Promise.resolve();
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      stopped = true;
      if (interval) clearInterval(interval);
      await diag.emit({
        component: 'worker-ban-sync',
        kind: 'ban_sync.stopped',
        severity: 'info',
        message: `ban-sync received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      // Closing the connection ends the blocked read at once. Only a job Redis
      // hands to that read in the same instant is affected: it stays pending
      // under this consumer, exactly as when the process is killed mid-read.
      manualRedis.disconnect();
      await manualLoop;
      // The tick stops between sources once `stopped` is set; waiting for the
      // source in progress keeps its merge from being cut off by `sql.end`.
      await runningTick;
      await sql.end({ timeout: 5 });
      await redis.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await diag.emit({
    component: 'worker-ban-sync',
    kind: 'ban_sync.started',
    severity: 'info',
    message: 'ban-sync started',
    payload: { pid: process.pid },
  });

  async function tick(): Promise<void> {
    try {
      const result = await runBanSyncTick(tickDeps);
      log.info(result, 'ban-sync tick');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'ban-sync tick failed');
    }
  }

  /** Starts a tick unless the previous one is still running (#853). */
  function startTick(): Promise<void> {
    if (runningTick) {
      log.warn('previous ban-sync tick still running; this tick skipped');
      return runningTick;
    }
    runningTick = tick().finally(() => {
      runningTick = null;
    });
    return runningTick;
  }

  await startTick();
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  interval = setInterval(startTick, TICK_INTERVAL_MS);

  manualLoop = runManualQueueLoop({
    redis,
    readRedis: manualRedis,
    consumer: `ban-sync-${process.pid}`,
    blockMs: MANUAL_BLOCK_MS,
    loadSource: (sourceId) => loadSourceById(db, sourceId),
    syncOne: (source) => syncSource(syncSourceDeps, source),
    inFlight,
    onSynced: (source, report) => {
      if (report.ok) backoff.delete(source.id);
    },
    log,
    shouldStop: () => stopped,
  }).catch((err) => {
    // The loop contains its own failures, so reaching this is a bug. Exit
    // rather than heartbeat while manual syncs are no longer consumed (#1292).
    log.fatal({ err: (err as Error).message }, 'manual-queue loop crashed; exiting');
    process.exit(1);
  });
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
