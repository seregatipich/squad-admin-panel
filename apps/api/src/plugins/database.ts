import { createDatabaseClient } from '@squad/db';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import { ensureVipLifecycleFenceAtStartup } from '../lib/vip-lifecycle-fence.js';

export default fp<{ config: AppConfig }>(async (app, opts) => {
  const db = createDatabaseClient(opts.config.DATABASE_URL);
  await ensureVipLifecycleFenceAtStartup(db, opts.config.VIP_LIFECYCLE_REQUIRE_REVISION);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    // drizzle's postgres.js driver doesn't expose a close(). The connection
    // pool is GC'd on process exit, so nothing to do here.
  });
});
