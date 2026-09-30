import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import { hostRedisUrl } from './integration/isolated-db.js';

let app: FastifyInstance;
let redis: Redis;
let publisher: Redis;

beforeEach(async () => {
  redis = new Redis(hostRedisUrl());
  publisher = new Redis(hostRedisUrl());
  app = Fastify({ logger: false });
  app.decorate('redis', redis);
  await app.register(liveBusPlugin);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await redis.quit();
  await publisher.quit();
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const marker = (serverId: string): LiveEvent => ({
  type: 'rcon.status',
  ts: new Date().toISOString(),
  data: { server_id: serverId, state: 'connected' },
});

describe('live-bus plugin robustness (#1301)', () => {
  it('drops malformed frames from Redis instead of fanning them out', async () => {
    const received: LiveEvent[] = [];
    app.liveBus.subscribe((event) => received.push(event));

    await publisher.publish('live-bus', JSON.stringify({ type: 'session.revoked' }));
    await publisher.publish('live-bus', JSON.stringify({ ts: 'x', data: {} }));
    await publisher.publish('live-bus', JSON.stringify([1, 2, 3]));
    await publisher.publish('live-bus', 'not json');
    await publisher.publish('rcon:status:changed', JSON.stringify({ state: 'up' }));
    const valid = marker('after-garbage');
    await publisher.publish('live-bus', JSON.stringify(valid));

    await waitFor(() => received.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([valid]);
  });

  it('still delivers well-formed rcon status messages', async () => {
    const received: LiveEvent[] = [];
    app.liveBus.subscribe((event) => received.push(event));

    await publisher.publish(
      'rcon:status:changed',
      JSON.stringify({ server_id: 's-1', state: 'connected', player_count: 3 }),
    );

    await waitFor(() => received.length > 0);
    expect(received[0]).toMatchObject({
      type: 'rcon.status',
      data: { server_id: 's-1', state: 'connected', player_count: 3 },
    });
  });

  it('isolates a throwing subscriber from the others and from publish()', async () => {
    const received: LiveEvent[] = [];
    app.liveBus.subscribe(() => {
      throw new Error('subscriber bug');
    });
    app.liveBus.subscribe((event) => received.push(event));

    const event = marker('local');
    expect(() => app.liveBus.publish(event)).not.toThrow();
    expect(received).toEqual([event]);
  });
});
