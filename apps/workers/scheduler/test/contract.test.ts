import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

// Mirrors `log-ingest`'s contract test: the spawned worker gets its own
// `DATABASE_URL` rather than relying on one happening to be in the runner's
// environment. Without it the worker exits 1 on `DATABASE_URL is required`
// before it can publish a heartbeat.
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;

workerContract({
  name: 'scheduler',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:scheduler',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    DATABASE_URL: databaseUrl,
    // This worker reads PANEL_BRIDGE_SOCKET, not BRIDGE_SOCKET — that is the
    // name its docker-compose service sets.
    PANEL_BRIDGE_SOCKET: process.env.PANEL_BRIDGE_SOCKET ?? '/run/panel-host-bridge/bridge.sock',
  },
});
