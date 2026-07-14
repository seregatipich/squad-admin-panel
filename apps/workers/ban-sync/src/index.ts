import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { createDiag } from '@squad/diag';
import { startHeartbeat } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { createSyncSourceDeps, syncSource } from './sync-source.js';
import type { DueSource } from './tick.js';
import { type BackoffMap, createTickDeps, runBanSyncTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-ban-sync' },
});

const MANUAL_STREAM = 'bansync:manual';
const MANUAL_GROUP = 'ban-sync';

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

interface ManualJob {
  source_id?: string;
  actor_player_id?: string | null;
  request_id?: string;
  enqueued_at?: string;
}

async function ensureManualGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', MANUAL_STREAM, MANUAL_GROUP, '$', 'MKSTREAM');
  } catch (err) {
    if ((err as Error).message?.includes('BUSYGROUP')) return;
    throw err;
  }
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

  const diag: Diag = createDiag({ redis, log });
  const syncSourceDeps = createSyncSourceDeps(db, redis, diag, encryptionKey);
  const backoff: BackoffMap = new Map();
  const tickDeps = createTickDeps(db, syncSourceDeps, backoff);

  // Heartbeat starts before any DB-dependent work below, so a slow/
  // unreachable Postgres never delays the liveness signal (mirrors
  // apps/workers/role-expirer/src/index.ts).
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'ban-sync',
    statusFn: () => 'running',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
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

  await ensureManualGroup(redis);
  const consumerName = `ban-sync-${process.pid}`;
  let stopped = false;

  async function processManualQueue(): Promise<void> {
    while (!stopped) {
      let result: [string, [string, string[]][]][] | null = null;
      try {
        result = (await redis.xreadgroup(
          'GROUP',
          MANUAL_GROUP,
          consumerName,
          'BLOCK',
          MANUAL_BLOCK_MS,
          'STREAMS',
          MANUAL_STREAM,
          '>',
        )) as [string, [string, string[]][]][] | null;
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'manual-queue xreadgroup failed');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!result) continue;

      for (const [, entries] of result) {
        for (const [entryId, fields] of entries) {
          const idx = fields.indexOf('job');
          const raw = idx >= 0 ? fields[idx + 1] : undefined;
          if (!raw) {
            await redis.xack(MANUAL_STREAM, MANUAL_GROUP, entryId);
            continue;
          }
          let job: ManualJob;
          try {
            job = JSON.parse(raw) as ManualJob;
          } catch (err) {
            log.warn({ err: (err as Error).message, entryId }, 'malformed bansync:manual job');
            await redis.xack(MANUAL_STREAM, MANUAL_GROUP, entryId);
            continue;
          }
          if (!job.source_id) {
            await redis.xack(MANUAL_STREAM, MANUAL_GROUP, entryId);
            continue;
          }
          try {
            const source = await loadSourceById(db, job.source_id);
            if (source) {
              // Manual sync bypasses the due-time check and the in-memory
              // backoff map entirely — it always runs immediately.
              const report = await syncSource(syncSourceDeps, source);
              if (report.ok) backoff.delete(source.id);
              log.info({ sourceId: source.id, ...report }, 'manual ban-sync');
            } else {
              log.warn({ sourceId: job.source_id }, 'manual sync requested for unknown source');
            }
          } catch (err) {
            log.error(
              { err: (err as Error).message, sourceId: job.source_id },
              'manual ban-sync failed',
            );
          }
          await redis.xack(MANUAL_STREAM, MANUAL_GROUP, entryId);
        }
      }
    }
  }

  await tick();
  const interval = setInterval(() => {
    tick().catch((err) => log.error({ err: (err as Error).message }, 'ban-sync tick failed'));
  }, TICK_INTERVAL_MS);

  const manualLoop = processManualQueue().catch((err) => {
    log.error({ err: (err as Error).message }, 'manual-queue loop crashed');
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    clearInterval(interval);
    await diag.emit({
      component: 'worker-ban-sync',
      kind: 'ban_sync.stopped',
      severity: 'info',
      message: `ban-sync received ${sig}`,
      payload: { sig },
    });
    stopHeartbeat();
    await manualLoop;
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
