import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'scheduler',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:scheduler',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
});
