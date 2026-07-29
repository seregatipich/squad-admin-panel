import { HEARTBEAT_PREFIX, type HeartbeatPayload } from '@squad/shared-config';
import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';

export default fp(async (app) => {
  app.get(
    '/health',
    { config: { public: true, audit: false }, schema: { hide: true } },
    async () => ({
      status: 'ok',
      uptime_s: process.uptime(),
      version: process.env.APP_VERSION ?? 'dev',
    }),
  );

  app.get(
    '/ready',
    { config: { public: true, audit: false }, schema: { hide: true } },
    async (_req, reply) => {
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
    },
  );

  app.get(
    '/api/v1/health/workers',
    { config: { permissions: ['host:view'], audit: false } },
    async () => {
      // Scan redis for worker:heartbeat:* — panel UI polls this to show
      // live/dead state per worker. Keys expire after HEARTBEAT_TTL_SECONDS
      // without a refresh, so stale workers drop off automatically.
      const pattern = `${HEARTBEAT_PREFIX}*`;
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await app.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '50');
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      const now = Date.now();
      const workers = await Promise.all(
        keys.map(async (k) => {
          const raw = await app.redis.get(k);
          if (!raw) return null;
          try {
            const hb = JSON.parse(raw) as HeartbeatPayload;
            const ageMs = now - new Date(hb.ts).getTime();
            return { ...hb, age_ms: ageMs };
          } catch {
            return null;
          }
        }),
      );
      const items = workers
        .filter((w): w is HeartbeatPayload & { age_ms: number } => w !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { items, total: items.length };
    },
  );

  app.get(
    '/api/v1/health/reconciler',
    { config: { permissions: ['host:view'], audit: false } },
    async () => {
      const stats = await app.statusReconciler.stats();
      return {
        ...stats,
        // Convenience flag the UI can poll: green when the loop is alive
        // (last tick within 3 intervals) AND no rows are stuck.
        healthy:
          stats.last_tick_at != null &&
          Date.now() - new Date(stats.last_tick_at).getTime() < 12_000 &&
          stats.consecutive_tick_errors === 0 &&
          stats.stuck_servers.length === 0,
      };
    },
  );
});
