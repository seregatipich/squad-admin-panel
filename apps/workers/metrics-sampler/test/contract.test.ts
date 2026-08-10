import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'metrics-sampler',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:metrics-sampler',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    BRIDGE_SOCKET: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
  },
});
