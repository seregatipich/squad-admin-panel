import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'audit-archiver',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:audit-archiver',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
});
