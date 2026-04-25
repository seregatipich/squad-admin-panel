import fp from 'fastify-plugin';

export interface BridgeHeartbeatHandle {
  tickOnce(): Promise<void>;
  stop(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    bridgeHeartbeat: BridgeHeartbeatHandle;
  }
}

const HEARTBEAT_INTERVAL_MS = 5_000;

export default fp(async (app) => {
  let lastWasUp = true;
  let lastDownAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickOnce(): Promise<void> {
    const t0 = Date.now();
    try {
      await app.bridge.ping();
      const rttMs = Date.now() - t0;
      if (!lastWasUp) {
        const downForS = lastDownAt ? Math.round((Date.now() - lastDownAt) / 1000) : 0;
        app.log.info({ src: 'bridge', rttMs, downForS }, `recovered after ${downForS}s`);
      } else {
        app.log.debug({ src: 'bridge', rttMs }, `alive rtt=${rttMs}ms`);
      }
      lastWasUp = true;
      lastDownAt = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (lastWasUp) {
        lastDownAt = Date.now();
        app.log.warn({ src: 'bridge', err: message }, `down: ${message}`);
      } else {
        app.log.debug({ src: 'bridge', err: message }, 'still down');
      }
      lastWasUp = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tickOnce();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  app.decorate('bridgeHeartbeat', { tickOnce, stop });
  app.addHook('onReady', async () => start());
  app.addHook('onClose', async () => stop());
});
