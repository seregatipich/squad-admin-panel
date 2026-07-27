import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'automation',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:automation',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
});
