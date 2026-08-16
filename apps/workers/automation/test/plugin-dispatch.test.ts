import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEnvelope, PluginHandler } from '@squad/shared-types';
import Redis from 'ioredis';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureConsumerGroup, runDispatchLoop } from '../src/dispatch.js';
import { PluginRegistry } from '../src/registry.js';

// Derive the endpoint instead of hardcoding it: the self-hosted CI runner maps
// redis to a dynamic host port, so `127.0.0.1:6379` is ECONNREFUSED there and
// every test in this file times out. Same fix the worker contract harness
// carries for #203 (`apps/workers/_test-shared/contract.ts`). Isolated on db 14;
// the literal is only a developer-machine fallback.
const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '14';
const TEST_REDIS_URL = `${(
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
).replace(/\/\d+$/, '')}/${TEST_REDIS_DB}`;

/**
 * Real Redis, real registry, real dispatch loop — this suite exercises the
 * wiring end to end, not mocks: XADD onto the shared event stream, run
 * `runDispatchLoop`, and observe what test plugins actually received.
 */
describe('automation plugin dispatch (integration)', () => {
  let redis: Redis | null = null;
  let stop: (() => void) | null = null;
  let loop: Promise<void> | null = null;

  let stream: string | null = null;

  afterEach(async () => {
    stop?.();
    await loop?.catch(() => undefined);
    if (stream) {
      await redis?.del(stream).catch(() => undefined);
    }
    await redis?.quit().catch(() => undefined);
    redis = null;
    stop = null;
    loop = null;
    stream = null;
  });

  function startLoop(
    registry: PluginRegistry,
    group: string,
    streamName: string,
    pluginTimeoutMs?: number,
  ) {
    let stopped = false;
    stop = () => {
      stopped = true;
    };
    loop = runDispatchLoop({
      redis: redis as Redis,
      registry,
      log: pino({ level: 'silent' }),
      group,
      consumer: `test-consumer-${randomUUID()}`,
      blockMs: 200,
      pluginTimeoutMs,
      shouldStop: () => stopped,
      // Pin discovery to this test's own stream so a concurrent process
      // XADDing to the shared `events:global` stream (e.g. another
      // `pnpm test:cov` worker) can never have its envelope delivered here.
      discoverStreams: async () => [streamName],
    });
  }

  function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
    return {
      event_id: randomUUID(),
      version: 1,
      type: 'player.connected',
      server_id: null,
      ts: new Date().toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload: { name: 'IntegrationPlayer', steam_id64: '76561198000000001' },
      ...overrides,
    };
  }

  function subscribedHandler(id: string, kinds: string[], onEvent: PluginHandler['onEvent']) {
    return {
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        subscribedEventKinds: kinds,
        requestedPermissions: ['events:read', 'events:payload'],
      },
      handler: { onEvent },
    };
  }

  async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('pollUntil: timed out');
      await sleep(50);
    }
  }

  it('delivers the exact envelope pushed onto the stream to a subscribed plugin', async () => {
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const group = `test-group-${randomUUID()}`;
    // Each test gets its own stream: `events:global` is shared with every
    // other suite (and every other concurrent `pnpm test:cov` worker) on the
    // same Redis db, so a unique group name alone cannot stop a foreign
    // envelope XADDed by someone else from being delivered here first.
    stream = `events:test:${randomUUID()}`;
    // Create the consumer group (positioned at '$') before anything is
    // pushed, so the dispatch loop's own (idempotent) group creation can't
    // race against the XADD below and miss the entry.
    await ensureConsumerGroup(redis, stream, group);
    const received: EventEnvelope[] = [];
    const registry = new PluginRegistry();
    registry.register(
      subscribedHandler('receiver-plugin', ['player.connected'], (envelope) => {
        received.push(envelope);
      }),
    );
    startLoop(registry, group, stream);

    const envelope = makeEnvelope();
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(envelope));

    await pollUntil(() => received.length === 1);
    expect(received[0]).toEqual(envelope);
  });

  it('a plugin not subscribed to the kind never receives it, while a subscribed one does', async () => {
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const group = `test-group-${randomUUID()}`;
    stream = `events:test:${randomUUID()}`;
    await ensureConsumerGroup(redis, stream, group);
    const registry = new PluginRegistry();
    const subscribedReceived: EventEnvelope[] = [];
    const unsubscribedReceived: EventEnvelope[] = [];
    registry.register(
      subscribedHandler('subscribed-plugin', ['player.connected'], (envelope) => {
        subscribedReceived.push(envelope);
      }),
    );
    registry.register(
      subscribedHandler('unsubscribed-plugin', ['player.disconnected'], (envelope) => {
        unsubscribedReceived.push(envelope);
      }),
    );
    startLoop(registry, group, stream);

    const envelope = makeEnvelope({ type: 'player.connected' });
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(envelope));

    await pollUntil(() => subscribedReceived.length === 1);
    await sleep(300);
    expect(unsubscribedReceived).toHaveLength(0);
  });

  it('a throwing plugin and a hanging plugin are isolated: neither crashes the loop nor blocks a third subscriber', async () => {
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const group = `test-group-${randomUUID()}`;
    stream = `events:test:${randomUUID()}`;
    await ensureConsumerGroup(redis, stream, group);
    const registry = new PluginRegistry();
    const survivorReceived: EventEnvelope[] = [];
    registry.register(
      subscribedHandler('throwing-plugin', ['player.connected'], () => {
        throw new Error('plugin exploded');
      }),
    );
    registry.register(
      subscribedHandler('hanging-plugin', ['player.connected'], () => sleep(60_000)),
    );
    registry.register(
      subscribedHandler('survivor-plugin', ['player.connected'], (envelope) => {
        survivorReceived.push(envelope);
      }),
    );
    startLoop(registry, group, stream, 200);

    const envelope = makeEnvelope();
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(envelope));

    await pollUntil(() => survivorReceived.length === 1);
    expect(survivorReceived[0]).toEqual(envelope);

    // The loop must still be alive and able to process a second event after
    // the throwing/hanging plugins ran.
    const secondEnvelope = makeEnvelope();
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(secondEnvelope));
    await pollUntil(() => survivorReceived.length === 2);
    expect(survivorReceived[1]).toEqual(secondEnvelope);
  }, 15_000);
});
