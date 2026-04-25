import type { BridgeClient } from '@squad/bridge-client';
import { HOST_METRICS_MAXLEN, HOST_METRICS_STREAM, packHostMetrics } from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface RunSamplerOpts {
  bridge: Pick<BridgeClient, 'hostMetrics'>;
  redis: Pick<Redis, 'xadd'>;
  log: Logger;
  intervalMs?: number;
}

export function runSampler(opts: RunSamplerOpts): () => void {
  const { bridge, redis, log } = opts;
  const intervalMs = opts.intervalMs ?? 15_000;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
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
