import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabaseClient } from '@squad/db';
import { createDiscordRedactingStream, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import { runNotifyLoop } from './consume.js';
import { loadEncryptionKey } from './crypto.js';
import type { DeliveryResult, SenderDeps } from './sender.js';

const log = pino(
  { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-discord' } },
  createDiscordRedactingStream(process.stdout),
);

/**
 * discord-notify worker (DISCORD-2): consumes the shared events stream
 * (EVT-1) and delivers matching envelopes to enabled `discord_webhooks` as
 * rendered embeds — see `mapping.ts`/`sender.ts`/`consume.ts`.
 *
 * `DATABASE_URL` and `APP_ENCRYPTION_KEY` are required to actually decrypt
 * webhook URLs and deliver anything; without either, the worker stays idle
 * (heartbeat only) rather than crash-looping, mirroring the `worker-stats`
 * degraded-idle guard — this keeps the existing `contract.test.ts` (which
 * only sets `REDIS_URL`) green.
 */
async function main() {
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
    : null;
  redis?.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis?.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const counters: DeliveryResult = { sent: 0, failed: 0, rateLimited: 0 };
  let stopped = false;
  let notifyLoop: Promise<void> = Promise.resolve();

  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKeyRaw = process.env.APP_ENCRYPTION_KEY;

  if (redis && databaseUrl && encryptionKeyRaw) {
    let encryptionKey: Buffer;
    try {
      encryptionKey = loadEncryptionKey(encryptionKeyRaw);
    } catch (err) {
      log.fatal({ err: (err as Error).message }, 'invalid APP_ENCRYPTION_KEY');
      process.exit(1);
    }

    const deps: SenderDeps = {
      db: createDatabaseClient(databaseUrl),
      encryptionKey,
      fetchImpl: fetch,
      sleep,
      log,
      // Reuses the API's existing PANEL_PUBLIC_URL (apps/api/src/config.ts) rather
      // than introducing a second panel-base-URL env var.
      panelBaseUrl: process.env.PANEL_PUBLIC_URL ?? null,
    };

    log.info('worker-discord started — notify loop active');
    const reclaimMinIdleMs = process.env.DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS
      ? Number(process.env.DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS)
      : undefined;
    notifyLoop = runNotifyLoop({
      ...deps,
      redis,
      reclaimMinIdleMs,
      shouldStop: () => stopped,
      onDelivery: (result) => {
        counters.sent += result.sent;
        counters.failed += result.failed;
        counters.rateLimited += result.rateLimited;
      },
    }).catch((err) => {
      log.error({ err: (err as Error).message }, 'notify loop crashed');
    });
  } else {
    log.info('worker-discord idle — DATABASE_URL/APP_ENCRYPTION_KEY unset, notify loop disabled');
  }

  const stopHeartbeat = redis
    ? startHeartbeat({
        redis,
        name: 'discord',
        statusFn: () =>
          `sent=${counters.sent} failed=${counters.failed} rateLimited=${counters.rateLimited}`,
        onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
      })
    : () => {};

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    stopHeartbeat();
    await notifyLoop;
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
