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
 * The notify and role-sync loops each block in `XREADGROUP … BLOCK` and so
 * each get their own `redis.duplicate()` connection; the heartbeat and the
 * status-channel loop share the main one and never queue behind a blocked
 * read. Any loop that settles (returns or throws) before shutdown ends the
 * process with exit code 1: a dead loop behind a live heartbeat would look
 * healthy forever, while an exit lets compose restart the worker.
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
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
    : null;
  redis?.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis?.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const counters: DeliveryResult = { sent: 0, failed: 0, rateLimited: 0 };
  const stopSignal = new AbortController();
  let stopped = false;
  const loopConnections: Redis[] = [];

  /** Abortable wait: shutdown ends it at once instead of waiting out a retry delay. */
  const interruptibleSleep = (ms: number): Promise<void> =>
    sleep(ms, undefined, { signal: stopSignal.signal }).catch(() => undefined);

  /** A dedicated connection for one blocking consumer loop, closed on shutdown. */
  const loopConnection = (client: Redis, name: string): Redis => {
    const connection = client.duplicate();
    connection.on('error', (err: Error) =>
      log.warn({ err: err.message, loop: name }, 'redis error (will retry)'),
    );
    loopConnections.push(connection);
    return connection;
  };

  /**
   * Exits the process when `loop` settles before shutdown was requested. The
   * loops are meant to run until `stopped`; one that returns or throws early
   * is dead, and the heartbeat alone would keep reporting the worker healthy.
   */
  const superviseLoop = (name: string, loop: Promise<void>): Promise<void> =>
    loop.then(
      () => {
        if (stopped) return;
        log.fatal({ loop: name }, 'loop exited unexpectedly; exiting so the worker restarts');
        process.exit(1);
      },
      (err: unknown) => {
        log.fatal(
          { loop: name, err: (err as Error).message },
          stopped ? 'loop failed during shutdown' : 'loop crashed; exiting so the worker restarts',
        );
        if (!stopped) process.exit(1);
      },
    );
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
      sleep: interruptibleSleep,
      log,
      // Reuses the API's existing PANEL_PUBLIC_URL (apps/api/src/config.ts) rather
      // than introducing a second panel-base-URL env var.
      panelBaseUrl: process.env.PANEL_PUBLIC_URL ?? null,
    };

    log.info('worker-discord started — notify, role-sync and status-channel loops active');
    const reclaimMinIdleMs = process.env.DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS
      ? Number(process.env.DISCORD_NOTIFY_RECLAIM_MIN_IDLE_MS)
      : undefined;
    notifyLoop = superviseLoop(
      'notify',
      runNotifyLoop({
        ...deps,
        redis: loopConnection(redis, 'notify'),
        reclaimMinIdleMs,
        shouldStop: () => stopped,
        onDelivery: (result) => {
          counters.sent += result.sent;
          counters.failed += result.failed;
          counters.rateLimited += result.rateLimited;
        },
      }),
    );

    // DISCORD-5 (#152): the role-sync loop shares this worker's DB/Redis/key
    // rather than getting its own service — it needs the same bot credentials
    // and the same encryption key, and adding a container buys nothing.
    // `loadDiscordBotContext` gates it: until an operator stores a guild id and
    // a bot token it consumes requests and does nothing.
    const reconcileIntervalMs = process.env.DISCORD_ROLE_SYNC_RECONCILE_MS
      ? Number(process.env.DISCORD_ROLE_SYNC_RECONCILE_MS)
      : DEFAULT_ROLE_SYNC_RECONCILE_MS;
    roleSyncLoop = superviseLoop(
      'role-sync',
      runRoleSyncLoop({
        redis: loopConnection(redis, 'role-sync'),
        db: deps.db,
        encryptionKey,
        fetchImpl: fetch,
        sleep: interruptibleSleep,
        log,
        shouldStop: () => stopped,
        reconcileIntervalMs,
      }),
    );

    // DISCORD-6 (#153): the status-channel tick and the one-off slash-command
    // registration ride in this same process for the same reason as the role
    // sync — one bot token, one set of credentials, no extra container.
    const statusChannelTickMs = process.env.DISCORD_STATUS_CHANNEL_MS
      ? Number(process.env.DISCORD_STATUS_CHANNEL_MS)
      : DEFAULT_STATUS_CHANNEL_TICK_MS;
    statusChannelLoop = superviseLoop(
      'status-channel',
      runStatusChannelLoop({
        db: deps.db,
        redis,
        encryptionKey,
        fetchImpl: fetch,
        // The tick interval is ten minutes; without an abortable wait a SIGTERM
        // arriving just after a tick would hold shutdown open for that long.
        sleep: interruptibleSleep,
        log,
        shouldStop: () => stopped,
        tickIntervalMs: statusChannelTickMs,
        applicationId: process.env.DISCORD_APPLICATION_ID ?? null,
      }),
    );
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
    await Promise.all(loopConnections.map((c) => c.quit().catch(() => undefined)));
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
