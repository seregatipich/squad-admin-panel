import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'media-publisher',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:media-publisher',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
});
