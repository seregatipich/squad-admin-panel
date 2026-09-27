import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverEventStreams } from '../src/dispatch.js';

const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * Regression for #16: the RNSquadJS sidecar in shadow mode writes a copy of
 * every event to `events:server:<id>:shadow`. That key matches the
 * `events:server:*` SCAN pattern, so the automation worker used to consume the
 * shadow copy as a live stream and act on every event twice.
 */
describe('discoverEventStreams (automation, real Redis)', () => {
  let redis: Redis;
  let serverId: string;

  beforeEach(() => {
    redis = new Redis(TEST_REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
    serverId = randomUUID();
  });

  afterEach(async () => {
    await redis.del(`events:server:${serverId}`, `events:server:${serverId}:shadow`);
    await redis.quit();
  });

  it('returns the live per-server stream and events:global', async () => {
    await redis.xadd(`events:server:${serverId}`, '*', 'envelope', '{}');

    const streams = await discoverEventStreams(redis);

    expect(streams).toContain('events:global');
    expect(streams).toContain(`events:server:${serverId}`);
  });

  it('never returns the sidecar shadow stream', async () => {
    await redis.xadd(`events:server:${serverId}`, '*', 'envelope', '{}');
    await redis.xadd(`events:server:${serverId}:shadow`, '*', 'envelope', '{}');

    const streams = await discoverEventStreams(redis);

    expect(streams).toContain(`events:server:${serverId}`);
    expect(streams).not.toContain(`events:server:${serverId}:shadow`);
    expect(streams.filter((stream) => stream.endsWith(':shadow'))).toEqual([]);
  });
});
