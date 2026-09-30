import { createDatabaseClient } from '@squad/db';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

/** Seconds `app.close()` lets in-flight queries finish before the pool is torn down. */
const POOL_CLOSE_TIMEOUT_SECONDS = 5;

/**
 * Decorates `app.db` with the drizzle client and ends its postgres.js pool on
 * `app.close()`, so a graceful shutdown drains queries instead of dropping
 * them when the process exits.
 */
export default fp<{ config: AppConfig }>(async (app, opts) => {
  const db = createDatabaseClient(opts.config.DATABASE_URL);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await db.$client.end({ timeout: POOL_CLOSE_TIMEOUT_SECONDS });
  });
});
