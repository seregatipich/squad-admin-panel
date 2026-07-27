import path from 'node:path';
import Redis from 'ioredis';
import { workerContract } from '../../_test-shared/contract.js';

workerContract({
  name: 'diag-flush',
  entryPath: path.resolve(import.meta.dirname, '../dist/index.js'),
  expectedHeartbeatKey: 'worker:heartbeat:diag-flush',
  createRedis: (url) => new Redis(url, { maxRetriesPerRequest: null }),
  envOverrides: {
    DIAG_JOURNALD_FORWARD: 'false',
  },
});
