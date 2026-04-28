import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { AppConfig } from '../config.js';

export default fp<{ config: AppConfig }>(async (app, opts) => {
  // maxRetriesPerRequest:null keeps commands queued through a redis bounce
  // instead of bailing after N retries. ioredis will auto-reconnect with its
  // default exponential-backoff retryStrategy. The `reconnectOnError` hook
  // also forces an immediate reconnect on READONLY / socket-ended frames.
  const redis = new Redis(opts.config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
    reconnectOnError: (err: Error) => err.message.includes('READONLY'),
  });
  let redisDown = false;
  redis.on('error', (err: Error) => {
    app.log.warn({ err: err.message }, 'redis error (will retry)');
    app.diag
      ?.emit({
        component: 'api',
        kind: 'redis.ping.fail',
        severity: 'error',
        message: `redis error: ${err.message}`,
        payload: { err: err.message },
      })
      .catch(() => undefined);
    redisDown = true;
  });
  redis.on('reconnecting', (delay: number) => {
    app.log.info({ delay }, 'redis reconnecting');
    app.diag
      ?.emit({
        component: 'api',
        kind: 'redis.reconnect.attempt',
        severity: 'warn',
        message: 'redis reconnecting',
        payload: { delayMs: delay },
      })
      .catch(() => undefined);
  });
  redis.on('ready', () => {
    app.log.info('redis ready');
    if (redisDown) {
      app.diag
        ?.emit({
          component: 'api',
          kind: 'redis.reconnect.success',
          severity: 'info',
          message: 'redis ready after a prior failure',
          payload: {},
        })
        .catch(() => undefined);
      redisDown = false;
    }
  });
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit().catch(() => undefined);
  });
});
