import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { pruneExpired } from '../lib/sessions.js';

/** How often expired `sessions` rows are deleted. */
const SESSION_PRUNE_INTERVAL_MS = 60 * 60_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** Deletes every expired session row once; exposed for tests. */
    sessionPruneTick: () => Promise<void>;
  }
}

/**
 * Periodically deletes `sessions` rows whose `expires_at` has passed. Nothing
 * else removes them — logout, revoke and role changes only delete the rows
 * they target — so without this sweep the table grows without bound (#37).
 * A failed sweep is logged and retried on the next tick; the timer is
 * unref'd so it never holds the process open.
 */
export const sessionPrunePlugin = fp(
  async (app: FastifyInstance) => {
    async function tick(): Promise<void> {
      try {
        const removed = await pruneExpired(app.db);
        if (removed > 0) app.log.info({ removed }, 'expired sessions pruned');
      } catch (err) {
        app.log.warn({ err: (err as Error).message }, 'session prune failed');
      }
    }

    app.decorate('sessionPruneTick', tick);

    const handle = setInterval(() => {
      void tick();
    }, SESSION_PRUNE_INTERVAL_MS);
    handle.unref();
    app.addHook('onClose', async () => {
      clearInterval(handle);
    });
  },
  { name: 'session-prune' },
);

export default sessionPrunePlugin;
