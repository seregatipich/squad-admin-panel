import { BridgeClient } from '@squad/bridge-client';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

export default fp<{ config: AppConfig }>(async (app, opts) => {
  const bridge = new BridgeClient({
    socketPath: opts.config.BRIDGE_SOCKET,
    onLog: (msg, meta) => app.log.info({ ...meta }, msg),
  });
  app.decorate('bridge', bridge);
  app.addHook('onClose', async () => {
    await bridge.close();
  });
});
