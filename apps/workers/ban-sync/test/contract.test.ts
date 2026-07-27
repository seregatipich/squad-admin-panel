import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;

workerContract({
  name: 'ban-sync',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:ban-sync',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    DATABASE_URL: databaseUrl,
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
});
