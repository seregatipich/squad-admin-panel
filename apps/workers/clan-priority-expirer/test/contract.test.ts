import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'clan-priority-expirer',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:clan-priority-expirer',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
});
