import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'scheduler',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:scheduler',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    // `DATABASE_URL` comes from the shared harness. Only the socket name needs
    // saying here: this worker reads PANEL_BRIDGE_SOCKET, not BRIDGE_SOCKET —
    // that is the name its docker-compose service sets.
    PANEL_BRIDGE_SOCKET: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
  },
});
