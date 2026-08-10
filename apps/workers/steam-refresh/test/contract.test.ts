import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'steam-refresh',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:steam-refresh',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    STEAM_API_KEY: '',
    STEAM_REFRESH_INTERVAL_MS: '3600000',
  },
});
