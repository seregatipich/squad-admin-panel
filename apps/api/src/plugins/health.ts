import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';

export default fp(async (app) => {
  app.get('/health', { config: { audit: false }, schema: { hide: true } }, async () => ({
    status: 'ok',
    uptime_s: process.uptime(),
    version: process.env.APP_VERSION ?? 'dev',
  }));

  app.get('/ready', { config: { audit: false }, schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    try {
      await app.db.execute(sql`SELECT 1`);
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = (err as Error).message;
    }
    try {
      const pong = await app.redis.ping();
      checks.redis = pong === 'PONG' ? 'ok' : pong;
    } catch (err) {
      checks.redis = (err as Error).message;
    }
    try {
      const res = await app.bridge.ping();
      checks.bridge = res.pong ? 'ok' : 'no pong';
    } catch (err) {
      checks.bridge = (err as Error).message;
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });
});
