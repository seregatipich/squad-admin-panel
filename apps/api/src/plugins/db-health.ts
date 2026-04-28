import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const PG_HEALTHCHECK_INTERVAL_MS = 30_000;

const PG_DOWN = new WeakMap<FastifyInstance, boolean>();

export async function pgHealthTick(app: FastifyInstance): Promise<void> {
  const wasDown = PG_DOWN.get(app) ?? false;
  try {
    await app.db.execute(sql`SELECT 1`);
    if (wasDown) {
      await app.diag.emit({
        component: 'api',
        kind: 'pg.ping.ok',
        severity: 'info',
        message: 'postgres responding after a prior failure',
        payload: {},
      });
      PG_DOWN.set(app, false);
    }
  } catch (err) {
    const message = (err as Error).message;
    await app.diag.emit({
      component: 'api',
      kind: 'pg.ping.fail',
      severity: 'error',
      message: `postgres ping failed: ${message}`,
      payload: { err: message },
    });
    PG_DOWN.set(app, true);
  }
}

export default fp(
  async (app: FastifyInstance) => {
    PG_DOWN.set(app, false);
    const handle = setInterval(() => {
      void pgHealthTick(app).catch(() => undefined);
    }, PG_HEALTHCHECK_INTERVAL_MS);
    handle.unref();
    app.addHook('onClose', async () => {
      clearInterval(handle);
      PG_DOWN.delete(app);
    });
  },
  { name: 'db-health' },
);
