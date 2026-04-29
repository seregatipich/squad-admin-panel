import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const KNOWN_WORKERS = [
  'rcon',
  'log-ingest',
  'audit-archiver',
  'event-partition',
  'diag-flush',
  'metrics-sampler',
] as const;

const HEARTBEAT_LOST_THRESHOLD_MS = 30_000;
const HEARTBEAT_TICK_MS = 30_000;

declare module 'fastify' {
  interface FastifyInstance {
    heartbeatWatchTick: () => Promise<void>;
  }
}

export const heartbeatWatchPlugin = fp(
  async (app: FastifyInstance) => {
    const lostSince = new Map<string, number>();
    const reported = new Set<string>();
    let inFlight = false;

    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const now = Date.now();
        for (const name of KNOWN_WORKERS) {
          const ttl = await app.redis.pttl(`worker:heartbeat:${name}`);
          if (ttl < 0) {
            const since = lostSince.get(name) ?? now;
            lostSince.set(name, since);
            if (!reported.has(name) && now - since > HEARTBEAT_LOST_THRESHOLD_MS) {
              await app.diag.emit({
                component: 'api',
                kind: 'worker.heartbeat_lost',
                severity: 'error',
                message: `worker ${name} heartbeat absent for >${HEARTBEAT_LOST_THRESHOLD_MS / 1000}s`,
                payload: { worker: name },
              });
              reported.add(name);
            }
          } else {
            if (reported.has(name)) {
              await app.diag.emit({
                component: 'api',
                kind: 'worker.heartbeat_recovered',
                severity: 'info',
                message: `worker ${name} heartbeat recovered`,
                payload: { worker: name },
              });
              reported.delete(name);
            }
            lostSince.delete(name);
          }
        }
      } catch (err) {
        app.log.warn({ err: (err as Error).message }, 'heartbeat-watch tick failed');
      } finally {
        inFlight = false;
      }
    }

    app.decorate('heartbeatWatchTick', tick);

    const handle = setInterval(() => {
      void tick();
    }, HEARTBEAT_TICK_MS);
    handle.unref?.();
    app.addHook('onClose', async () => {
      clearInterval(handle);
    });
  },
  { name: 'heartbeat-watch' },
);

export default heartbeatWatchPlugin;
