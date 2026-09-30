import type { BridgeClient } from '@squad/bridge-client';
import {
  CONTAINER_METRICS_MAXLEN,
  CONTAINER_METRICS_TTL_SECONDS,
  HOST_METRICS_MAXLEN,
  HOST_METRICS_STREAM,
  packHostMetrics,
} from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface RunSamplerOpts {
  bridge: Pick<BridgeClient, 'hostMetrics' | 'containerStats'>;
  redis: Pick<Redis, 'xadd' | 'expire' | 'scan' | 'mget'>;
  log: Logger;
  intervalMs?: number;
}

const RCON_STATUS_PREFIX = 'rcon:status:';

/** Parses a stored `rcon:status:<id>` value; anything but a JSON object yields `null`. */
function parseRconStatus(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Lists the servers whose RCON supervisor is connected or connecting. Each SCAN
 * page is read with a single MGET instead of one GET per key.
 */
export async function getRunningServerIds(redis: Pick<Redis, 'scan' | 'mget'>): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${RCON_STATUS_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    if (keys.length === 0) continue;
    const values = await redis.mget(...keys);
    keys.forEach((key, index) => {
      const state = parseRconStatus(values[index] ?? null)?.state;
      if (state === 'connected' || state === 'connecting') {
        ids.push(key.slice(RCON_STATUS_PREFIX.length));
      }
    });
  } while (cursor !== '0');
  return ids;
}

export async function collectContainerMetrics(
  bridge: Pick<BridgeClient, 'containerStats'>,
  redis: Pick<Redis, 'xadd' | 'expire' | 'mget'>,
  serverIds: string[],
  log: Logger,
): Promise<void> {
  if (serverIds.length === 0) return;

  // One round trip for every server's tickrate; a failed read only drops tickrate.
  const statuses = await redis
    .mget(...serverIds.map((serverId) => `${RCON_STATUS_PREFIX}${serverId}`))
    .catch(() => serverIds.map(() => null));

  for (const [index, serverId] of serverIds.entries()) {
    try {
      const stats = await bridge.containerStats({ name: `squad-${serverId}` });
      if (!stats.found) continue;

      const tickrateRt = parseRconStatus(statuses[index] ?? null)?.tickrate_rt;
      const tickrate = typeof tickrateRt === 'number' ? tickrateRt : undefined;

      const streamKey = `container:metrics:${serverId}`;
      await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        String(CONTAINER_METRICS_MAXLEN),
        '*',
        'v',
        JSON.stringify({
          cpu_percent: stats.cpu_percent,
          mem_bytes: stats.mem_used_bytes,
          mem_percent: stats.mem_percent,
          pids: stats.pids,
          timestamp: stats.sampled_at,
          tickrate,
        }),
      );
      await redis.expire(streamKey, CONTAINER_METRICS_TTL_SECONDS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug({ err: msg, serverId }, 'container metrics sample failed');
    }
  }
}

export function runSampler(opts: RunSamplerOpts): () => void {
  const { bridge, redis, log } = opts;
  const intervalMs = opts.intervalMs ?? 15_000;
  let stopped = false;
  let tickCount = 0;
  let tickInFlight = false;

  /**
   * One sampling pass. Ticks never overlap: with a slow bridge a pass can
   * outlast the interval, and stacking passes would multiply concurrent RPCs to
   * the privileged bridge and duplicate stream writes.
   */
  async function tick(): Promise<void> {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    try {
      await sampleOnce();
    } finally {
      tickInFlight = false;
    }
  }

  async function sampleOnce(): Promise<void> {
    tickCount++;
    try {
      const m = await bridge.hostMetrics();
      const v = packHostMetrics(m);
      await redis.xadd(
        HOST_METRICS_STREAM,
        'MAXLEN',
        '~',
        String(HOST_METRICS_MAXLEN),
        '*',
        'v',
        JSON.stringify(v),
      );
      log.debug({ v }, 'metrics sample stored');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, `metrics sample failed: ${message}`);
    }

    // Container metrics every ~30s (every 2nd tick at default 15s interval)
    if (tickCount % 2 === 0) {
      try {
        const serverIds = await getRunningServerIds(redis);
        if (serverIds.length > 0) {
          await collectContainerMetrics(bridge, redis, serverIds, log);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message }, 'container metrics collection failed');
      }
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
