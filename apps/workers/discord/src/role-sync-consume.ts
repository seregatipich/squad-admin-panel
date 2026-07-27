import type { DatabaseClient } from '@squad/db';
import {
  DISCORD_ROLE_SYNC_GROUP,
  DISCORD_ROLE_SYNC_STATUS_KEY,
  DISCORD_ROLE_SYNC_STREAM,
  type DiscordRoleSyncRequest,
  discordRoleSyncRequest,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { DiscordFailure } from './discord-rest.js';
import {
  type DiscordBotContext,
  loadDiscordBotContext,
  type RoleSyncDeps,
  reconcileLinkedPlayers,
  syncPlayerDiscordRoles,
} from './role-sync.js';

/** Consumer group every worker-discord process shares on the role-sync stream. */
export const ROLE_SYNC_CONSUMER_GROUP = DISCORD_ROLE_SYNC_GROUP;
/** How long a single XREADGROUP call blocks waiting for new requests. */
export const DEFAULT_BLOCK_MS = 1_000;
export const DEFAULT_BATCH_SIZE = 50;
/** A request idle this long is reclaimed from a dead consumer via XAUTOCLAIM. */
export const DEFAULT_RECLAIM_MIN_IDLE_MS = 30_000;
export const DEFAULT_RECLAIM_BATCH_SIZE = 50;
/** How long the last-outcome status survives without a refresh, in seconds. */
export const STATUS_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Parses the `payload` field out of a raw XREADGROUP field array (matching the
 * API's `publishDiscordRoleSync` XADD) and validates it. Returns `null` for a
 * malformed request instead of throwing, so one bad entry never stalls the loop.
 */
export function parseRoleSyncRequest(fields: string[]): DiscordRoleSyncRequest | null {
  const idx = fields.indexOf('payload');
  const raw = idx >= 0 ? fields[idx + 1] : undefined;
  if (!raw) return null;
  try {
    const parsed = discordRoleSyncRequest.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Publishes the last sync outcome so `GET /api/v1/integrations/discord/role-mappings`
 * — and through it the settings page — can show an operator that the sync is
 * broken. Without this a bot missing Manage Roles would fail invisibly, which
 * is exactly the failure mode DISCORD-5's acceptance criteria forbid.
 */
async function publishStatus(
  redis: Redis,
  log: Logger,
  failure: DiscordFailure | null,
): Promise<void> {
  const status = {
    state: failure ? 'error' : 'ok',
    reason: failure?.reason ?? null,
    message: failure?.message ?? null,
    checked_at: new Date().toISOString(),
  };
  try {
    await redis.set(
      DISCORD_ROLE_SYNC_STATUS_KEY,
      JSON.stringify(status),
      'EX' as never,
      STATUS_TTL_SECONDS as never,
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'discord role-sync status publish failed');
  }
}

export interface RunRoleSyncLoopOpts {
  redis: Redis;
  db: DatabaseClient;
  encryptionKey: Buffer;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  group?: string;
  consumer?: string;
  blockMs?: number;
  batchSize?: number;
  reclaimMinIdleMs?: number;
  reclaimBatchSize?: number;
  /** Polled once per loop iteration; the loop returns once this is true. */
  shouldStop: () => boolean;
  /** Overridable so tests can inject a bot context without a database. */
  loadBotContext?: (db: DatabaseClient, encryptionKey: Buffer) => Promise<DiscordBotContext | null>;
  /** Reconcile interval; `0` disables the periodic tick (the stream still works). */
  reconcileIntervalMs?: number;
  now?: () => number;
}

/**
 * worker-discord's role-sync consumer (DISCORD-5, #152): reads
 * `discord:role-sync` requests and drives each named player's Discord roles to
 * what the panel says, plus an hourly full reconcile that repairs drift in
 * both directions.
 *
 * Requests are acked whether or not a sync actually happened — including while
 * the Discord bot is unconfigured. Redelivery would not help (the bot is still
 * unconfigured a second later) and the reconcile tick re-derives everything
 * once the operator finishes the setup, so nothing is lost by acking.
 */
export async function runRoleSyncLoop(opts: RunRoleSyncLoopOpts): Promise<void> {
  const {
    redis,
    db,
    encryptionKey,
    log,
    group = ROLE_SYNC_CONSUMER_GROUP,
    consumer = `discord-role-sync-${process.pid}`,
    blockMs = DEFAULT_BLOCK_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    reclaimMinIdleMs = DEFAULT_RECLAIM_MIN_IDLE_MS,
    reclaimBatchSize = DEFAULT_RECLAIM_BATCH_SIZE,
    shouldStop,
    loadBotContext = loadDiscordBotContext,
    reconcileIntervalMs = 0,
    now = Date.now,
  } = opts;

  await redis
    .xgroup('CREATE', DISCORD_ROLE_SYNC_STREAM, group, '$', 'MKSTREAM')
    .catch((err: Error) => {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    });

  let nextReconcileAt =
    reconcileIntervalMs > 0 ? now() + reconcileIntervalMs : Number.POSITIVE_INFINITY;

  const buildDeps = (context: DiscordBotContext): RoleSyncDeps => ({
    db,
    guildId: context.guildId,
    botToken: context.botToken,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log,
  });

  const handleRequest = async (request: DiscordRoleSyncRequest): Promise<void> => {
    const context = await loadBotContext(db, encryptionKey);
    if (!context) {
      log.debug(
        { reason: request.reason },
        'discord role sync skipped — bot token or guild not configured',
      );
      return;
    }
    const deps = buildDeps(context);
    if (request.player_id === null) {
      const summary = await reconcileLinkedPlayers(deps);
      await publishStatus(redis, log, summary.lastError);
      return;
    }
    const result = await syncPlayerDiscordRoles(deps, request.player_id);
    await publishStatus(redis, log, result.error ?? null);
  };

  const processEntry = async (id: string, fields: string[]): Promise<void> => {
    const request = parseRoleSyncRequest(fields);
    if (!request) {
      log.warn({ id }, 'malformed discord role-sync request; acking without action');
    } else {
      await handleRequest(request);
    }
    await redis.xack(DISCORD_ROLE_SYNC_STREAM, group, id);
  };

  while (!shouldStop()) {
    try {
      const claimed = (await redis.xautoclaim(
        DISCORD_ROLE_SYNC_STREAM,
        group,
        consumer,
        reclaimMinIdleMs,
        '0-0',
        'COUNT',
        reclaimBatchSize,
      )) as [string, [string, string[]][], string[]];
      for (const [id, fields] of claimed?.[1] ?? []) {
        await processEntry(id, fields);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!message.includes('NOGROUP')) log.warn({ err: message }, 'role-sync xautoclaim failed');
    }

    try {
      const res = (await redis.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        batchSize,
        'BLOCK',
        blockMs,
        'STREAMS',
        DISCORD_ROLE_SYNC_STREAM,
        '>',
      )) as [string, [string, string[]][]][] | null;
      for (const [, entries] of res ?? []) {
        for (const [id, fields] of entries) {
          try {
            await processEntry(id, fields);
          } catch (err) {
            log.error(
              { err: (err as Error).message, id },
              'role-sync request failed; left pending for redelivery',
            );
          }
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'role-sync poll iteration failed');
      await sleepMs(1000);
    }

    if (now() >= nextReconcileAt) {
      nextReconcileAt = now() + reconcileIntervalMs;
      try {
        await handleRequest({ player_id: null, reason: 'scheduled_reconcile' });
      } catch (err) {
        log.error({ err: (err as Error).message }, 'scheduled discord role reconcile failed');
      }
    }
  }
}
