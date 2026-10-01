import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import { hostRedisUrl } from './integration/isolated-db.js';

// Regression for #37 finding #1314: frames arriving on the Redis `live-bus`
// channel were cast to LiveEvent without any check, so a worker's
// undocumented type (or a malformed frame) reached every subscriber.

let app: FastifyInstance;
let publisher: Redis;
const received: LiveEvent[] = [];

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('live-bus Redis frames', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate('redis', new Redis(hostRedisUrl()));
    await app.register(liveBusPlugin);
    await app.ready();
    app.liveBus.subscribe((event) => received.push(event));
    publisher = new Redis(hostRedisUrl());
  });

  afterAll(async () => {
    await app?.close();
    await app?.redis.quit();
    await publisher?.quit();
  });

  it('delivers a well-formed frame of a known type and drops unknown or malformed ones', async () => {
    const marker = `frame-${Date.now()}`;
    const frames: unknown[] = [
      { type: 'banname.matched', ts: marker, data: { player_id: 'p1' } },
      { type: 'server.status', ts: marker },
      { type: 'server.status', ts: marker, data: 'not-an-object' },
      { ts: marker, data: {} },
      {
        type: 'server.status',
        ts: marker,
        data: { server_id: 's1', status: 'running', source: 'reconciler' },
      },
    ];
    for (const frame of frames) {
      await publisher.publish('live-bus', JSON.stringify(frame));
    }

    const ours = () => received.filter((event) => event.ts === marker);
    await waitFor(() => ours().some((event) => 'data' in event && typeof event.data === 'object'));
    // Pub/sub keeps publish order: the well-formed frame is last, so every
    // rejected frame before it has already been handled.

    expect(ours()).toEqual([
      {
        type: 'server.status',
        ts: marker,
        data: { server_id: 's1', status: 'running', source: 'reconciler' },
      },
    ]);
  });
});
