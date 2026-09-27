import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { AppConfig } from '../config.js';

/**
 * Longest a command waits for a reply, including time spent in the offline
 * queue while Redis is unreachable. HTTP handlers then fail fast instead of
 * hanging for the length of an outage (#37).
 */
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Reconnect attempts after which ioredis rejects the commands still queued.
 * With the retry backoff below this bounds the offline queue to a few seconds
 * of traffic during an outage.
 */
const REDIS_MAX_RETRIES_PER_REQUEST = 3;

/**
 * The shared ioredis client (`app.redis`). A command waits at most
 * {@link REDIS_COMMAND_TIMEOUT_MS}; ioredis reconnects with a capped
 * exponential backoff, and `reconnectOnError` forces an immediate reconnect on
 * READONLY frames. Clients made with `app.redis.duplicate()` inherit these
 * options; a long blocking read must override `commandTimeout`.
 *
 * An outage is reported once: the first `error` emits `redis.ping.fail` and
 * the first `reconnecting` emits `redis.reconnect.attempt`; `ready` ends the
 * outage and emits `redis.reconnect.success`. Emitting on every retry would
 * queue diag writes (themselves Redis commands) behind the dead connection.
 */
export default fp<{ config: AppConfig }>(async (app, opts) => {
  const redis = new Redis(opts.config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
    reconnectOnError: (err: Error) => err.message.includes('READONLY'),
  });
  let redisDown = false;
  let reconnectReported = false;
  redis.on('error', (err: Error) => {
    if (redisDown) {
      app.log.debug({ err: err.message }, 'redis error (will retry)');
      return;
    }
    redisDown = true;
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
  });
  redis.on('reconnecting', (delay: number) => {
    app.log.info({ delay }, 'redis reconnecting');
    if (reconnectReported) return;
    reconnectReported = true;
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
    reconnectReported = false;
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
    // QUIT would sit in the offline queue while Redis is unreachable.
    if (redis.status !== 'ready') {
      redis.disconnect();
      return;
    }
    await redis.quit().catch(() => undefined);
  });
});
