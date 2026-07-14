import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'log-ingest',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:log-ingest',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgres://admin:g3rlRkR6QTfGoN4svPLjEA7dCDbS553C@127.0.0.1:5432/admin',
    BRIDGE_SOCKET: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
  },
});
