import type { BridgeClient } from '@squad/bridge-client';
import { HOST_METRICS_MAXLEN, HOST_METRICS_STREAM, packHostMetrics } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface RunSamplerOpts {
  bridge: Pick<BridgeClient, 'hostMetrics' | 'containerStats'>;
  redis: Pick<Redis, 'xadd' | 'scan' | 'get'>;
  log: Logger;
  intervalMs?: number;
}

export async function getRunningServerIds(redis: Pick<Redis, 'scan' | 'get'>): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'rcon:status:*', 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.state === 'connected' || parsed.state === 'connecting') {
          ids.push(key.replace('rcon:status:', ''));
        }
      } catch {
        // skip malformed
      }
    }
  } while (cursor !== '0');
  return ids;
}

export async function collectContainerMetrics(
  bridge: Pick<BridgeClient, 'containerStats'>,
  redis: Pick<Redis, 'xadd'>,
  serverIds: string[],
  log: Logger,
): Promise<void> {
  for (const serverId of serverIds) {
    try {
      const stats = await bridge.containerStats({ name: `squad-${serverId}` });
      if (!stats.found) continue;
      await redis.xadd(
        `container:metrics:${serverId}`,
        'MAXLEN',
        '~',
        '2880',
        '*',
        'v',
        JSON.stringify({
          cpu_percent: stats.cpu_percent,
          mem_bytes: stats.mem_used_bytes,
          mem_percent: stats.mem_percent,
          pids: stats.pids,
          timestamp: stats.sampled_at,
        }),
      );
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

  async function tick(): Promise<void> {
    if (stopped) return;
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
