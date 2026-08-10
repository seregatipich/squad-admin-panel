import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;

workerContract({
  name: 'config-sync',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:config-sync',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    DATABASE_URL: databaseUrl,
    PANEL_BRIDGE_SOCKET: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
  },
});
