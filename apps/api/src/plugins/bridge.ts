import { BridgeClient } from '@squad/bridge-client';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

const RTT_OUTLIER_THRESHOLD_MS = 50;
/** At most one `bridge.rtt.outlier` per window, so a slow socket cannot flood diagnostics. */
const RTT_OUTLIER_THROTTLE_MS = 60_000;

export default fp<{ config: AppConfig }>(async (app, opts) => {
  const bridge = new BridgeClient({
    socketPath: opts.config.BRIDGE_SOCKET,
    onLog: (msg, meta) => app.log.info({ ...meta }, msg),
  });
  bridge.on('connected', (info) => {
    app.diag
      .emit({
        component: 'api',
        kind: 'bridge.client.connected',
        severity: 'info',
        message: `bridge connected (rtt=${info.rttMs}ms, version=${info.version})`,
        payload: {
          rttMs: info.rttMs,
          version: info.version,
          hostname: info.hostname,
        },
      })
      .catch(() => undefined);
  });
  bridge.on('disconnected', (reason) => {
    app.diag
      .emit({
        component: 'api',
        kind: 'bridge.client.disconnected',
        severity: 'error',
        message: `bridge disconnected: ${reason}`,
        payload: { reason: String(reason) },
      })
      .catch(() => undefined);
  });
  bridge.on('rpc-error', ({ method, code, message }) => {
    app.diag
      .emit({
        component: 'api',
        kind: 'bridge.rpc.error',
        severity: 'warn',
        message: `${method} -> ${code}: ${message}`,
        payload: { method, code, message },
      })
      .catch(() => undefined);
  });
  // Only a `ping` round trip measures the socket: every other method's duration
  // is its own work (a container stop, an install), not transport latency.
  let lastOutlierAt = Number.NEGATIVE_INFINITY;
  bridge.on('rtt', (rttMs, method) => {
    if (method !== 'ping' || rttMs <= RTT_OUTLIER_THRESHOLD_MS) return;
    const now = Date.now();
    if (now - lastOutlierAt < RTT_OUTLIER_THROTTLE_MS) return;
    lastOutlierAt = now;
    app.diag
      .emit({
        component: 'api',
        kind: 'bridge.rtt.outlier',
        severity: 'warn',
        message: `bridge ${method} RTT ${rttMs}ms exceeds ${RTT_OUTLIER_THRESHOLD_MS}ms threshold`,
        payload: { rttMs, thresholdMs: RTT_OUTLIER_THRESHOLD_MS, method },
      })
      .catch(() => undefined);
  });
  app.decorate('bridge', bridge);
  app.decorate(
    'makeBridgeClient',
    () =>
      new BridgeClient({
        socketPath: opts.config.BRIDGE_SOCKET,
        onLog: (msg, meta) => app.log.debug({ ...meta }, msg),
      }),
  );
  app.addHook('onClose', async () => {
    await bridge.close();
  });
});
