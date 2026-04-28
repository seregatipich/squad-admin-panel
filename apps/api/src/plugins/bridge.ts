import { BridgeClient } from '@squad/bridge-client';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

const RTT_OUTLIER_THRESHOLD_MS = 50;

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
  bridge.on('rtt', (rttMs) => {
    if (rttMs > RTT_OUTLIER_THRESHOLD_MS) {
      app.diag
        .emit({
          component: 'api',
          kind: 'bridge.rtt.outlier',
          severity: 'warn',
          message: `bridge RTT ${rttMs}ms exceeds ${RTT_OUTLIER_THRESHOLD_MS}ms threshold`,
          payload: { rttMs, thresholdMs: RTT_OUTLIER_THRESHOLD_MS },
        })
        .catch(() => undefined);
    }
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
