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
import { createMediaPublisherDeps } from './deps.js';
import { runMediaPublisherTick } from './tick.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-media-publisher' },
});

/**
 * Poll interval for the publication queue. A minute is deliberate: publishing
 * is a showcase side-channel, uploads take far longer than the interval, and
 * both destinations meter their APIs.
 */
const TICK_INTERVAL_MS = Number(process.env.MEDIA_PUBLISHER_INTERVAL_MS ?? 60_000);
/** Publications handled per tick — bounded so one large upload cannot stall the loop indefinitely. */
const BATCH_SIZE = Number(process.env.MEDIA_PUBLISHER_BATCH_SIZE ?? 3);

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
    name: 'media-publisher',
    statusFn: () => 'running',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const runtimeDeps = createMediaPublisherDeps(db, {
    mediaBaseDir: process.env.MEDIA_STORAGE_DIR ?? './media',
    env: {
      YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
      YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    },
  });

  await diag.emit({
    component: 'worker-media-publisher',
    kind: 'media_publisher.started',
    severity: 'info',
    message: 'media-publisher started',
    payload: {
      pid: process.pid,
      // Presence only — a credential value must never reach a log or diag event.
      youtube_configured: Boolean(runtimeDeps.publishers.youtube),
      telegram_configured: Boolean(runtimeDeps.publishers.telegram),
    },
  });

  async function tick(): Promise<void> {
    const result = await runMediaPublisherTick({ ...runtimeDeps, diag, batchSize: BATCH_SIZE });
    if (result.claimed > 0) log.info(result, 'media-publisher tick');
  }

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      log.info({ sig }, 'shutdown');
      if (interval) clearInterval(interval);
      await diag.emit({
        component: 'worker-media-publisher',
        kind: 'media_publisher.stopped',
        severity: 'info',
        message: `media-publisher received ${sig}`,
        payload: { sig },
      });
      stopHeartbeat();
      await sql.end({ timeout: 5 });
      await redis.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await tick().catch((err) =>
    log.error({ err: (err as Error).message }, 'media-publisher tick failed'),
  );
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;
  interval = setInterval(() => {
    tick().catch((err) =>
      log.error({ err: (err as Error).message }, 'media-publisher tick failed'),
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
  main().catch((err) => {
    log.fatal({ err: (err as Error).message }, 'fatal');
    process.exit(1);
  });
}
