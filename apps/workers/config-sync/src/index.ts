import { BridgeClient } from '@squad/bridge-client';
import { createDatabaseClient, relayAdminsCfgSyncOutbox, servers } from '@squad/db';
import { redisSinkStream, startHeartbeat } from '@squad/shared-config';
import { isNull } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { sweepServerConfigDrift } from './config-drift.js';
import { syncServerAdminsCfg } from './syncer.js';

const ADMINS_CFG_SYNC_STREAM_PREFIX = 'events:admins-cfg-sync:';
const ADMINS_CFG_SYNC_GROUP = 'config-sync';

interface ParsedEvent {
  reason?: string;
  actor_player_id?: string | null;
  enqueued_at?: string;
  request_id?: string;
  forceWrite?: boolean;
}

const requiredEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`fatal: ${name} is required`);
    process.exit(1);
  }
  return v;
};

const SERVERS_REFRESH_MS = 30_000;
const DRIFT_INTERVAL_MS = Number(process.env.ADMINS_CFG_DRIFT_INTERVAL_MS ?? 5 * 60_000);
// CFG-2 (#64): generic per-file drift sweep over the non-managed config files
// (separate cadence from the Admins.cfg managed-segment sweep above).
const CONFIG_DRIFT_INTERVAL_MS = Number(process.env.CONFIG_DRIFT_INTERVAL_MS ?? 5 * 60_000);
const STREAM_BLOCK_MS = 5_000;
// Pending-message claim cadence + minimum-idle window. A message that has
// been delivered to *some* consumer but not XACK'd within `RECLAIM_MIN_IDLE_MS`
// (e.g. because that consumer crashed, was renamed across restarts, or
// hit `state=unreachable`) is reclaimed by this consumer via XAUTOCLAIM
// and replayed. This is the bottom of the spec §2.7.7 retry stack.
const RECLAIM_INTERVAL_MS = Number(process.env.ADMINS_CFG_RECLAIM_INTERVAL_MS ?? 30_000);
const RECLAIM_MIN_IDLE_MS = Number(process.env.ADMINS_CFG_RECLAIM_MIN_IDLE_MS ?? 60_000);
// Cadence for draining the durable Postgres outbox onto the Redis streams
// (SYNC-1, #34). The API publishes immediately on enqueue as a fast path; this
// sweep is the at-least-once fallback that delivers any row whose immediate
// publish failed (e.g. Redis was briefly unavailable), so no committed mutation
// is ever stranded without its sync task.
const RELAY_INTERVAL_MS = Number(process.env.ADMINS_CFG_RELAY_INTERVAL_MS ?? 1_000);
const CONSUMER_NAME = `consumer-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function ensureGroup(redis: Redis, serverId: string): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`,
      ADMINS_CFG_SYNC_GROUP,
      '$',
      'MKSTREAM',
    );
  } catch (err) {
    if ((err as Error).message?.includes('BUSYGROUP')) return;
    throw err;
  }
}

async function main() {
  const db = createDatabaseClient(requiredEnv('DATABASE_URL'));
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-config-sync' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'config-sync' }) },
    ]),
  );
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const bridge = new BridgeClient({
    socketPath: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
    onLog: (msg, meta) => log.info({ ...meta }, msg),
  });
  await bridge.connect();

  let activeServerIds = new Set<string>();
  const backoffByServer = new Map<string, { delayMs: number; nextAttemptAt: number }>();
  const ctx = { db, redis, bridge, log };

  async function refreshServerList(): Promise<void> {
    const rows = await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
    const next = new Set(rows.map((r) => r.id));
    for (const id of next) {
      if (!activeServerIds.has(id)) {
        await ensureGroup(redis, id);
      }
    }
    activeServerIds = next;
  }

  function shouldSkip(serverId: string): boolean {
    const b = backoffByServer.get(serverId);
    if (!b) return false;
    return Date.now() < b.nextAttemptAt;
  }

  function recordOutcome(serverId: string, ok: boolean): void {
    if (ok) {
      backoffByServer.delete(serverId);
      return;
    }
    const prev = backoffByServer.get(serverId)?.delayMs ?? 5_000;
    const next = Math.min(prev * 2, 5 * 60_000);
    backoffByServer.set(serverId, { delayMs: next, nextAttemptAt: Date.now() + next });
  }

  async function processStreamEvents(): Promise<void> {
    if (activeServerIds.size === 0) {
      await new Promise((r) => setTimeout(r, STREAM_BLOCK_MS));
      return;
    }
    const streamArgs: string[] = [];
    const ids: string[] = [];
    for (const id of activeServerIds) {
      if (shouldSkip(id)) continue;
      streamArgs.push(`${ADMINS_CFG_SYNC_STREAM_PREFIX}${id}`);
      ids.push('>');
    }
    if (streamArgs.length === 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return;
    }
    let result: Array<[string, Array<[string, string[]]>]> | null = null;
    try {
      result = (await redis.xreadgroup(
        'GROUP',
        ADMINS_CFG_SYNC_GROUP,
        CONSUMER_NAME,
        'COUNT',
        '50',
        'BLOCK',
        STREAM_BLOCK_MS,
        'STREAMS',
        ...streamArgs,
        ...ids,
      )) as Array<[string, Array<[string, string[]]>]> | null;
    } catch (err) {
      const msg = (err as Error).message;
      // A destroyed per-server stream/group (its server was soft-deleted,
      // SYNC-5) makes the multiplexed XREADGROUP reject NOGROUP for the WHOLE
      // batch, stalling sync for every server until the next 30 s refresh.
      // Recover immediately: re-query the server list so the vanished id is
      // dropped (and its group is not re-created), prune its per-server
      // backoff, and let the next loop iteration read the surviving streams.
      if (/NOGROUP|no such key/i.test(msg)) {
        log.info({ err: msg }, 'xreadgroup NOGROUP — refreshing server list');
        await refreshServerList().catch((refreshErr) =>
          log.warn(
            { err: (refreshErr as Error).message },
            'server-list refresh after NOGROUP failed',
          ),
        );
        for (const id of backoffByServer.keys()) {
          if (!activeServerIds.has(id)) backoffByServer.delete(id);
        }
        return;
      }
      log.warn({ err: msg }, 'xreadgroup failed');
      await new Promise((r) => setTimeout(r, 1000));
      return;
    }
    if (!result) return;
    for (const [streamName, entries] of result) {
      const serverId = streamName.slice(ADMINS_CFG_SYNC_STREAM_PREFIX.length);
      for (const [streamId, kv] of entries) {
        const evIdx = kv.indexOf('event');
        if (evIdx < 0 || evIdx + 1 >= kv.length) {
          await redis.xack(streamName, ADMINS_CFG_SYNC_GROUP, streamId);
          continue;
        }
        let event: ParsedEvent;
        try {
          event = JSON.parse(kv[evIdx + 1] ?? '{}') as ParsedEvent;
        } catch (err) {
          log.warn(
            { err: (err as Error).message, streamId, serverId },
            'malformed admins-cfg-sync event',
          );
          await redis.xack(streamName, ADMINS_CFG_SYNC_GROUP, streamId);
          continue;
        }
        try {
          const syncResult = await syncServerAdminsCfg(ctx, serverId, {
            reason: event.reason ?? 'unknown',
            actorPlayerId: event.actor_player_id ?? null,
            forceWrite: event.reason === 'force_sync' || event.forceWrite === true,
          });
          recordOutcome(serverId, syncResult.state !== 'unreachable');
          log.info(
            {
              serverId,
              state: syncResult.state,
              groups: syncResult.groupsCount,
              admins: syncResult.adminsCount,
              reason: event.reason,
            },
            'admins.cfg sync',
          );
          if (syncResult.state === 'unreachable') {
            // Spec §2.7.7 — bridge error means the file did NOT get the
            // change. Leave the message unacked so it is redelivered to
            // some consumer (possibly us) after the per-server backoff
            // window. The audit row is appended on the failure path so
            // the operator has a trail.
            log.warn(
              { serverId, streamId, error: syncResult.error },
              'admins.cfg unreachable — leaving event unacked for retry',
            );
            continue;
          }
          await redis.xack(streamName, ADMINS_CFG_SYNC_GROUP, streamId);
        } catch (err) {
          log.error({ serverId, streamId, err: (err as Error).message }, 'admins.cfg sync failed');
          recordOutcome(serverId, false);
          // do NOT XACK so the message is re-delivered on next read after backoff.
        }
      }
    }
  }

  async function reclaimPendingMessages(): Promise<void> {
    // For every active server, take over any messages that have been
    // pending in the consumer group for more than RECLAIM_MIN_IDLE_MS
    // and replay them. This handles three scenarios:
    //   (a) a previous consumer crashed mid-handle
    //   (b) a previous consumer restarted (new CONSUMER_NAME) and
    //       orphaned its pending list
    //   (c) the unreachable-and-not-acked branch in
    //       processStreamEvents: if the bridge stays unreachable longer
    //       than the drift sweep but new mutations keep arriving, the
    //       earlier messages must still get replayed once the bridge
    //       comes back.
    for (const serverId of activeServerIds) {
      const stream = `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`;
      try {
        // ioredis types for XAUTOCLAIM are loose; cast to a tuple of
        // [nextStartId, claimedEntries[], deletedIds[]].
        const result = (await redis.xautoclaim(
          stream,
          ADMINS_CFG_SYNC_GROUP,
          CONSUMER_NAME,
          RECLAIM_MIN_IDLE_MS,
          '0-0',
          'COUNT',
          50,
        )) as [string, Array<[string, string[]]>, string[]];
        const claimed = result?.[1] ?? [];
        if (claimed.length === 0) continue;
        log.info(
          { serverId, claimed: claimed.length },
          'reclaimed pending admins-cfg-sync messages',
        );
        for (const [streamId, kv] of claimed) {
          const evIdx = kv.indexOf('event');
          if (evIdx < 0 || evIdx + 1 >= kv.length) {
            await redis.xack(stream, ADMINS_CFG_SYNC_GROUP, streamId);
            continue;
          }
          let event: ParsedEvent;
          try {
            event = JSON.parse(kv[evIdx + 1] ?? '{}') as ParsedEvent;
          } catch {
            await redis.xack(stream, ADMINS_CFG_SYNC_GROUP, streamId);
            continue;
          }
          try {
            const syncResult = await syncServerAdminsCfg(ctx, serverId, {
              reason: event.reason ?? 'unknown',
              actorPlayerId: event.actor_player_id ?? null,
              forceWrite: event.reason === 'force_sync' || event.forceWrite === true,
            });
            recordOutcome(serverId, syncResult.state !== 'unreachable');
            if (syncResult.state === 'unreachable') {
              // Stays in PEL; another reclaim cycle will retry.
              continue;
            }
            await redis.xack(stream, ADMINS_CFG_SYNC_GROUP, streamId);
          } catch (err) {
            log.error(
              { serverId, streamId, err: (err as Error).message },
              'reclaimed message handler failed',
            );
            recordOutcome(serverId, false);
            // leave unacked; next reclaim cycle picks it up.
          }
        }
      } catch (err) {
        // ioredis throws if the stream / group doesn't exist yet — fine,
        // refreshServerList recreates the group lazily.
        const msg = (err as Error).message;
        if (
          !msg.includes('NOGROUP') &&
          !msg.includes('no such key') &&
          !msg.includes('Unknown command')
        ) {
          log.warn({ serverId, err: msg }, 'xautoclaim failed');
        }
      }
    }
  }

  async function relayOutbox(): Promise<void> {
    try {
      const { relayed } = await relayAdminsCfgSyncOutbox(db, redis, {
        streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
        maxlen: 500,
      });
      if (relayed > 0) log.info({ relayed }, 'relayed admins-cfg-sync outbox rows');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'admins-cfg-sync outbox relay failed');
    }
  }

  async function driftSweep(): Promise<void> {
    for (const serverId of activeServerIds) {
      if (shouldSkip(serverId)) continue;
      try {
        const result = await syncServerAdminsCfg(ctx, serverId, {
          reason: 'drift_check',
          actorPlayerId: null,
          forceWrite: false,
        });
        recordOutcome(serverId, result.state !== 'unreachable');
        if (result.state === 'drift') {
          log.warn(
            { serverId, expected: result.expectedHash, actual: result.actualHash },
            'admins.cfg drift detected — awaiting force-sync',
          );
        }
      } catch (err) {
        log.error({ serverId, err: (err as Error).message }, 'drift sweep failed');
        recordOutcome(serverId, false);
      }
    }
  }

  async function configDriftSweep(): Promise<void> {
    for (const serverId of activeServerIds) {
      try {
        const status = await sweepServerConfigDrift(ctx, serverId);
        const drifted = Object.entries(status.files)
          .filter(([, f]) => f.state === 'drift')
          .map(([name]) => name);
        if (drifted.length > 0) {
          log.warn({ serverId, files: drifted }, 'config files drifted — awaiting resolution');
        }
      } catch (err) {
        log.error({ serverId, err: (err as Error).message }, 'config drift sweep failed');
      }
    }
  }

  await refreshServerList();
  // Boot-time reclaim pass — picks up anything orphaned by a prior
  // process restart (consumer name regenerates each boot).
  await reclaimPendingMessages().catch((err) =>
    log.warn({ err: (err as Error).message }, 'boot reclaim failed'),
  );
  // Boot-time relay pass — drain any outbox rows whose immediate publish never
  // reached Redis (e.g. Redis was down when the mutation committed).
  await relayOutbox();
  const refreshTimer = setInterval(() => {
    refreshServerList().catch((err) =>
      log.error({ err: (err as Error).message }, 'server-list refresh failed'),
    );
  }, SERVERS_REFRESH_MS);
  const driftTimer = setInterval(() => {
    driftSweep().catch((err) => log.error({ err: (err as Error).message }, 'drift sweep failed'));
  }, DRIFT_INTERVAL_MS);
  const configDriftTimer = setInterval(() => {
    configDriftSweep().catch((err) =>
      log.error({ err: (err as Error).message }, 'config drift sweep failed'),
    );
  }, CONFIG_DRIFT_INTERVAL_MS);
  const reclaimTimer = setInterval(() => {
    reclaimPendingMessages().catch((err) =>
      log.error({ err: (err as Error).message }, 'reclaim sweep failed'),
    );
  }, RECLAIM_INTERVAL_MS);
  const relayTimer = setInterval(() => {
    relayOutbox().catch((err) =>
      log.error({ err: (err as Error).message }, 'outbox relay sweep failed'),
    );
  }, RELAY_INTERVAL_MS);

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'config-sync',
    statusFn: () => `servers=${activeServerIds.size}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  let stopped = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    log.info({ sig }, 'shutdown');
    stopHeartbeat();
    clearInterval(refreshTimer);
    clearInterval(driftTimer);
    clearInterval(configDriftTimer);
    clearInterval(reclaimTimer);
    clearInterval(relayTimer);
    await bridge.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info({ consumer: CONSUMER_NAME }, 'worker-config-sync ready');
  while (!stopped) {
    await processStreamEvents();
  }
}

main().catch((err) => {
  console.error('fatal', (err as Error).message);
  process.exit(1);
});
