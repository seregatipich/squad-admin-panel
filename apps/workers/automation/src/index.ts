import { startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import { runDispatchLoop } from './dispatch.js';
import { BUILTIN_PLUGINS, loadPlugins } from './loader.js';
import { PluginRegistry } from './registry.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-automation' },
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return value;
}

/**
 * Plugin/event-hook host worker (INT-4). Loads the compiled-in plugin set,
 * then runs a Redis-stream consumer that dispatches every EventEnvelope
 * (published by worker-log-ingest / worker-rcon) to plugins subscribed to
 * its kind. See `dispatch.ts` for the consumer loop and permission gate.
 */
async function main() {
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  const registry = new PluginRegistry();
  loadPlugins(registry, BUILTIN_PLUGINS);
  log.info({ plugins: registry.list().map((p) => p.id) }, 'plugins loaded');

  let stopped = false;
  const dispatchLoop = runDispatchLoop({
    redis,
    registry,
    log,
    shouldStop: () => stopped,
  }).catch((err) => {
    log.error({ err: (err as Error).message }, 'dispatch loop crashed');
  });

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'automation',
    statusFn: () => `plugins=${registry.list().length}`,
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    stopHeartbeat();
    await dispatchLoop;
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info('worker-automation ready');
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
