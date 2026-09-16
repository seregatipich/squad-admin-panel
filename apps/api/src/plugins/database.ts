import { createDatabaseClient } from '@squad/db';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

export default fp<{ config: AppConfig }>(async (app, opts) => {
  const db = createDatabaseClient(opts.config.DATABASE_URL);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    // drizzle's postgres.js driver doesn't expose a close(). The connection
    // pool is GC'd on process exit, so nothing to do here.
  });
});
