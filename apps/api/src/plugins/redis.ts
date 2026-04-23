import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { AppConfig } from '../config.js';

export default fp<{ config: AppConfig }>(async (app, opts) => {
  const redis = new Redis(opts.config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
  redis.on('error', (err) => {
    app.log.error({ err: err.message }, 'redis error');
  });
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit().catch(() => undefined);
  });
});
