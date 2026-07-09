import { BridgeClient } from '@squad/bridge-client';
import { createDiag } from '@squad/diag';
import { redisSinkStream, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { emitStarted, emitStopped } from './lifecycle.js';
import { runSampler } from './sampler.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`fatal: ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });

  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-metrics-sampler' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'worker' }) },
    ]),
  );

  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const bridge = new BridgeClient({
    socketPath: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
    onLog: (m, meta) => log.debug({ src: 'bridge', ...meta }, m),
  });

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'metrics-sampler',
    intervalMs: 5_000,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const diag = createDiag({ redis, log });
  await emitStarted(diag);

  const stopSampler = runSampler({ bridge, redis, log });

  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutdown');
    // Watchdog: guarantee a clean exit even if graceful teardown stalls (e.g. the
    // bridge close or a redis quit hangs). Mirrors worker-rcon's shutdown contract.
    const forceExit = setTimeout(() => {
      log.warn('graceful shutdown timed out; forcing exit');
      process.exit(0);
    }, 3000);
    forceExit.unref();
    stopSampler();
    await emitStopped(diag, sig).catch(() => undefined);
    stopHeartbeat();
    await redis.quit().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
