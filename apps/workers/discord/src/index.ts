import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabaseClient } from '@squad/db';
import { createDiscordRedactingStream, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import { runNotifyLoop } from './consume.js';
import { loadEncryptionKey } from './crypto.js';
import { runRoleSyncLoop } from './role-sync-consume.js';
import type { DeliveryResult, SenderDeps } from './sender.js';
import { DEFAULT_STATUS_CHANNEL_TICK_MS, runStatusChannelLoop } from './status-channel-loop.js';

/** DISCORD-5 (#152): how often the role-sync drift repair runs, in ms. */
const DEFAULT_ROLE_SYNC_RECONCILE_MS = 3_600_000;

const log = pino(
  { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-discord' } },
  createDiscordRedactingStream(process.stdout),
);

/**
 * discord worker. Two independent loops share one process:
 *
 * - **notify** (DISCORD-2) — consumes the shared events stream (EVT-1) and
 *   delivers matching envelopes to enabled `discord_webhooks` as rendered
 *   embeds; see `mapping.ts`/`sender.ts`/`consume.ts`.
 * - **role sync** (DISCORD-5) — consumes `discord:role-sync` requests and
 *   drives every linked player's Discord guild roles from `players.role_id`
 *   through `discord_role_mappings`, plus an hourly reconcile that repairs
 *   drift in both directions; see `role-sync.ts`/`role-sync-consume.ts`.
 * - **status channel** (DISCORD-6) — renames each server's configured Discord
 *   channel to a live summary of map/online/queue/admins and registers the
 *   read-only slash commands; see `status-channel.ts`/`status-channel-loop.ts`.
 *   The slash-command *invocations* land on the API
 *   (`apps/api/src/routes/discord-interactions.ts`), not here.
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
  const stopSignal = new AbortController();
  let stopped = false;
  let notifyLoop: Promise<void> = Promise.resolve();
  let roleSyncLoop: Promise<void> = Promise.resolve();
  let statusChannelLoop: Promise<void> = Promise.resolve();

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

    log.info('worker-discord started — notify, role-sync and status-channel loops active');
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

    // DISCORD-5 (#152): the role-sync loop shares this worker's DB/Redis/key
    // rather than getting its own service — it needs the same bot credentials
    // and the same encryption key, and adding a container buys nothing.
    // `loadDiscordBotContext` gates it: until an operator stores a guild id and
    // a bot token it consumes requests and does nothing.
    const reconcileIntervalMs = process.env.DISCORD_ROLE_SYNC_RECONCILE_MS
      ? Number(process.env.DISCORD_ROLE_SYNC_RECONCILE_MS)
      : DEFAULT_ROLE_SYNC_RECONCILE_MS;
    roleSyncLoop = runRoleSyncLoop({
      redis,
      db: deps.db,
      encryptionKey,
      fetchImpl: fetch,
      sleep,
      log,
      shouldStop: () => stopped,
      reconcileIntervalMs,
    }).catch((err) => {
      log.error({ err: (err as Error).message }, 'role-sync loop crashed');
    });

    // DISCORD-6 (#153): the status-channel tick and the one-off slash-command
    // registration ride in this same process for the same reason as the role
    // sync — one bot token, one set of credentials, no extra container.
    const statusChannelTickMs = process.env.DISCORD_STATUS_CHANNEL_MS
      ? Number(process.env.DISCORD_STATUS_CHANNEL_MS)
      : DEFAULT_STATUS_CHANNEL_TICK_MS;
    statusChannelLoop = runStatusChannelLoop({
      db: deps.db,
      redis,
      encryptionKey,
      fetchImpl: fetch,
      // The tick interval is ten minutes; without an abortable wait a SIGTERM
      // arriving just after a tick would hold shutdown open for that long.
      sleep: (ms) => sleep(ms, undefined, { signal: stopSignal.signal }).catch(() => undefined),
      log,
      shouldStop: () => stopped,
      tickIntervalMs: statusChannelTickMs,
      applicationId: process.env.DISCORD_APPLICATION_ID ?? null,
    }).catch((err) => {
      log.error({ err: (err as Error).message }, 'status-channel loop crashed');
    });
  } else {
    log.info(
      'worker-discord idle — DATABASE_URL/APP_ENCRYPTION_KEY unset, notify, role-sync and status-channel loops disabled',
    );
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
    if (stopped) return;
    stopped = true;
    stopSignal.abort();
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    await Promise.all([notifyLoop, roleSyncLoop, statusChannelLoop]);
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
