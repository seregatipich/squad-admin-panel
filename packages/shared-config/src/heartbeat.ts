/// <reference types="node" />
/**
 * Shared worker-heartbeat contract.
 *
 * Every long-running worker SHOULD call `startHeartbeat(redis, name)` on
 * startup. The helper writes `worker:heartbeat:{name}` to Redis every
 * {@link HEARTBEAT_INTERVAL_MS} ms with a TTL of {@link HEARTBEAT_TTL_SECONDS}.
 *
 * A missing key means the worker has been dead for at least the TTL.
 * A key older than `2 × interval` but still present means the worker is
 * alive but behind (very slow tick, GC pause). The API surfaces both
 * signals on `/api/v1/health/workers`.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_SECONDS = 30;
export const HEARTBEAT_PREFIX = 'worker:heartbeat:';

/**
 * Heartbeat names of the workers every deployment runs — one per `worker-*`
 * service in `docker/compose.yml` (a test in `apps/api` keeps the two in
 * sync). The API's heartbeat watch reports `worker.heartbeat_lost` when one
 * of them stops publishing. `backup` and `stats` have no compose service and
 * are therefore not watched.
 */
export const MONITORED_WORKERS = [
  'audit-archiver',
  'automation',
  'ban-sync',
  'clan-guard',
  'clan-priority-expirer',
  'config-sync',
  'diag-flush',
  'discord',
  'event-partition',
  'leaderboard-aggregator',
  'log-ingest',
  'media-publisher',
  'metrics-sampler',
  'presence-daily',
  'rcon',
  'role-expirer',
  'scheduler',
  'seed-reward',
  'steam-refresh',
] as const;

export type MonitoredWorker = (typeof MONITORED_WORKERS)[number];

export interface HeartbeatPayload {
  name: string;
  ts: string;
  pid: number;
  hostname?: string;
  version?: string;
  started_at: string;
  status?: string;
}

export function heartbeatKey(name: string): string {
  return HEARTBEAT_PREFIX + name;
}

/**
 * Shape of the minimal Redis interface the heartbeat helper needs. Real
 * ioredis clients satisfy it; tests can pass a mock.
 */
export interface HeartbeatRedis {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
}

export interface StartHeartbeatOptions {
  redis: HeartbeatRedis;
  name: string;
  intervalMs?: number;
  ttlSeconds?: number;
  version?: string;
  onError?: (err: Error) => void;
  /** Returns a short ad-hoc status string published alongside each heartbeat. */
  statusFn?: () => string | undefined;
}

/**
 * Kick off a periodic heartbeat. Returns a function that stops publishing.
 * Safe to call multiple times with different names.
 */
export function startHeartbeat(opts: StartHeartbeatOptions): () => void {
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const ttl = opts.ttlSeconds ?? HEARTBEAT_TTL_SECONDS;
  const started = new Date().toISOString();

  const publish = async () => {
    try {
      const payload: HeartbeatPayload = {
        name: opts.name,
        ts: new Date().toISOString(),
        pid: process.pid,
        hostname: process.env.HOSTNAME,
        version: opts.version,
        started_at: started,
        status: opts.statusFn?.(),
      };
      await opts.redis.set(heartbeatKey(opts.name), JSON.stringify(payload), 'EX', ttl);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  };

  // publish immediately so the UI isn't blind for the first tick
  void publish();
  const handle = setInterval(publish, interval);
  return () => {
    clearInterval(handle);
  };
}
