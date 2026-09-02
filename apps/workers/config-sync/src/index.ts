import { BridgeClient } from '@squad/bridge-client';
import { createDatabaseClient, relayAdminsCfgSyncOutbox, servers } from '@squad/db';
import {
  createGracefulShutdownController,
  redisSinkStream,
  startHeartbeat,
} from '@squad/shared-config';
import { isNull } from 'drizzle-orm';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { sweepServerConfigDrift } from './config-drift.js';
import {
  ADMINS_CFG_SYNC_GROUP,
  acknowledgeAndDeleteAdminsCfgEntry,
  handleAdminsCfgSyncEntry,
} from './delivery.js';
import { syncServerAdminsCfg } from './syncer.js';

const ADMINS_CFG_SYNC_STREAM_PREFIX = 'events:admins-cfg-sync:';

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
// (SYNC-1, #34). API and worker producers only write Postgres; this post-commit
// relay is the sole publisher for Admins.cfg streams.
const RELAY_INTERVAL_MS = Number(process.env.ADMINS_CFG_RELAY_INTERVAL_MS ?? 1_000);
const RELAY_XADD_TIMEOUT_MS = Number(process.env.ADMINS_CFG_RELAY_XADD_TIMEOUT_MS ?? 5_000);
const CONSUMER_NAME = `consumer-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function ensureGroup(redis: Redis, serverId: string): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`,
      ADMINS_CFG_SYNC_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (err) {
    if ((err as Error).message?.includes('BUSYGROUP')) return;
    throw err;
  }
}

async function main() {
  const db = createDatabaseClient(requiredEnv('DATABASE_URL'));
  const redisUrl = requiredEnv('REDIS_URL');
  const redis = new Redis(redisUrl, {
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
  const relayRedis = new Redis(redisUrl, {
    enableOfflineQueue: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    commandTimeout: RELAY_XADD_TIMEOUT_MS,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  relayRedis.on('error', (err: Error) =>
    log.warn({ err: err.message }, 'outbox relay redis error (will retry)'),
  );

  const bridge = new BridgeClient({
    socketPath: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
    onLog: (msg, meta) => log.info({ ...meta }, msg),
  });

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

  async function handleEntry(
    serverId: string,
    streamName: string,
    streamId: string,
    kv: string[],
  ): Promise<void> {
    const evIdx = kv.indexOf('event');
    if (evIdx < 0 || evIdx + 1 >= kv.length) {
      await acknowledgeAndDeleteAdminsCfgEntry(redis, streamName, streamId);
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(kv[evIdx + 1] ?? '{}');
    } catch (err) {
      log.warn(
        { err: (err as Error).message, streamId, serverId },
        'malformed admins-cfg-sync event',
      );
      await acknowledgeAndDeleteAdminsCfgEntry(redis, streamName, streamId);
      return;
    }

    const outcome = await handleAdminsCfgSyncEntry(ctx, {
      serverId,
      streamName,
      streamId,
      event,
    });
    recordOutcome(serverId, outcome === 'completed');
    if (outcome === 'retry') {
      log.warn({ serverId, streamId }, 'admins.cfg delivery left pending for retry');
    }
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
        try {
          await handleEntry(serverId, streamName, streamId, kv);
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
          try {
            await handleEntry(serverId, stream, streamId, kv);
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

  let relayInFlight: Promise<void> | null = null;
  function relayOutbox(): Promise<void> {
    if (relayInFlight) return relayInFlight;
    relayInFlight = (async () => {
      try {
        const { relayed } = await relayAdminsCfgSyncOutbox(db, relayRedis, {
          streamPrefix: ADMINS_CFG_SYNC_STREAM_PREFIX,
          xaddTimeoutMs: RELAY_XADD_TIMEOUT_MS,
        });
        if (relayed > 0) log.info({ relayed }, 'relayed admins-cfg-sync outbox rows');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'admins-cfg-sync outbox relay failed');
      }
    })().finally(() => {
      relayInFlight = null;
    });
    return relayInFlight;
  }

  async function driftSweep(): Promise<void> {
    for (const serverId of activeServerIds) {
      if (shouldSkip(serverId)) continue;
      try {
        const result = await syncServerAdminsCfg(ctx, serverId, {
          reason: 'drift_check',
          actorPlayerId: null,
          forceWrite: false,
          mode: 'passive',
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

  let stopped = false;
  let refreshTimer: NodeJS.Timeout | null = null;
  let driftTimer: NodeJS.Timeout | null = null;
  let configDriftTimer: NodeJS.Timeout | null = null;
  let reclaimTimer: NodeJS.Timeout | null = null;
  let relayTimer: NodeJS.Timeout | null = null;
  let stopHeartbeat = () => {};
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      stopped = true;
      log.info({ sig }, 'shutdown');
      stopHeartbeat();
      if (refreshTimer) clearInterval(refreshTimer);
      if (driftTimer) clearInterval(driftTimer);
      if (configDriftTimer) clearInterval(configDriftTimer);
      if (reclaimTimer) clearInterval(reclaimTimer);
      if (relayTimer) clearInterval(relayTimer);
      await bridge.close().catch(() => undefined);
      await relayRedis.quit().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  // Connect eagerly for the log line, but do NOT die if the bridge is not up:
  // `BridgeClient` dials on demand (`packages/bridge-client/src/client.ts`), so
  // the per-server sync reconnects on its own. Nothing else on this boot path
  // needs it — `refreshServerList` is DB+Redis and `relayOutbox` guards itself —
  // and exiting here meant `startHeartbeat` below never ran, so the worker read
  // as dead rather than degraded. Matches `metrics-sampler`, `log-ingest` and
  // `scheduler`.
  await bridge
    .connect()
    .catch((err: Error) => log.warn({ err: err.message }, 'bridge not reachable at startup'));
  await refreshServerList();
  // Boot-time reclaim pass — picks up anything orphaned by a prior
  // process restart (consumer name regenerates each boot).
  await reclaimPendingMessages().catch((err) =>
    log.warn({ err: (err as Error).message }, 'boot reclaim failed'),
  );
  // Boot-time post-commit relay pass — publish durable pending rows left by
  // producers or a previous worker run.
  await relayOutbox();
  stopHeartbeat = startHeartbeat({
    redis,
    name: 'config-sync',
    statusFn: () => `servers=${activeServerIds.size}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;

  refreshTimer = setInterval(() => {
    refreshServerList().catch((err) =>
      log.error({ err: (err as Error).message }, 'server-list refresh failed'),
    );
  }, SERVERS_REFRESH_MS);
  driftTimer = setInterval(() => {
    driftSweep().catch((err) => log.error({ err: (err as Error).message }, 'drift sweep failed'));
  }, DRIFT_INTERVAL_MS);
  configDriftTimer = setInterval(() => {
    configDriftSweep().catch((err) =>
      log.error({ err: (err as Error).message }, 'config drift sweep failed'),
    );
  }, CONFIG_DRIFT_INTERVAL_MS);
  reclaimTimer = setInterval(() => {
    reclaimPendingMessages().catch((err) =>
      log.error({ err: (err as Error).message }, 'reclaim sweep failed'),
    );
  }, RECLAIM_INTERVAL_MS);
  relayTimer = setInterval(() => {
    relayOutbox().catch((err) =>
      log.error({ err: (err as Error).message }, 'outbox relay sweep failed'),
    );
  }, RELAY_INTERVAL_MS);

  log.info({ consumer: CONSUMER_NAME }, 'worker-config-sync ready');
  while (!stopped) {
    await processStreamEvents();
  }
}

main().catch((err) => {
  console.error('fatal', (err as Error).message);
  process.exit(1);
});
