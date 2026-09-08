import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_TYPES, RedisPublisher } from '../src/panel-bridge/redis-publisher.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';

function makeRedis() {
  return { xadd: vi.fn().mockResolvedValue('1-0'), set: vi.fn().mockResolvedValue('OK') };
}

function envelope(type) {
  return {
    event_id: '019dbaa5-1234-7abc-8def-0123456789ab',
    version: 1,
    type,
    server_id: SERVER_ID,
    ts: '2026-09-08T03:00:00.000Z',
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {},
  };
}

describe('RedisPublisher key namespaces', () => {
  let redis;

  beforeEach(() => {
    redis = makeRedis();
  });

  it('writes shadow-mode events to the shadow stream with a capped length', async () => {
    const publisher = new RedisPublisher(redis, SERVER_ID, 'shadow');

    await publisher.publishEvent(envelope('player.damaged'));

    expect(redis.xadd).toHaveBeenCalledWith(
      `events:server:${SERVER_ID}:shadow`,
      'MAXLEN',
      '~',
      '10000',
      '*',
      'envelope',
      JSON.stringify(envelope('player.damaged')),
    );
  });

  it('writes production events to the live stream', async () => {
    const publisher = new RedisPublisher(redis, SERVER_ID, 'production');

    await publisher.publishEvent(envelope('player.connected'));

    expect(redis.xadd.mock.calls[0][0]).toBe(`events:server:${SERVER_ID}`);
  });

  it('publishes the sidecar status under the engine-neutral key', async () => {
    const publisher = new RedisPublisher(redis, SERVER_ID, 'production');

    await publisher.publishRconStatus({
      state: 'connected',
      lastChange: '2026-09-08T03:00:00.000Z',
    });

    expect(redis.set).toHaveBeenCalledWith(
      `sidecar:status:${SERVER_ID}`,
      JSON.stringify({ state: 'connected', lastChange: '2026-09-08T03:00:00.000Z' }),
      'EX',
      300,
    );
  });

  it('publishes the shadow status under the shadow key', async () => {
    const publisher = new RedisPublisher(redis, SERVER_ID, 'shadow');

    await publisher.publishRconStatus({ state: 'disconnected', lastChange: 'x' });

    expect(redis.set.mock.calls[0][0]).toBe(`sidecar:status:${SERVER_ID}:shadow`);
  });
});

describe('RedisPublisher production type filter', () => {
  it('carries exactly the five legacy-parity types', () => {
    expect([...PRODUCTION_TYPES].sort()).toEqual([
      'match.ended',
      'match.started',
      'player.connected',
      'player.disconnected',
      'player.name_changed',
    ]);
  });

  it('drops non-production types before they reach XADD', async () => {
    const redis = makeRedis();
    const publisher = new RedisPublisher(redis, SERVER_ID, 'production');

    for (const type of ['player.damaged', 'chat.message', 'squad.created', 'server.tick_rate']) {
      await publisher.publishEvent(envelope(type));
    }

    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('publishes every production type in production mode', async () => {
    const redis = makeRedis();
    const publisher = new RedisPublisher(redis, SERVER_ID, 'production');

    for (const type of PRODUCTION_TYPES) await publisher.publishEvent(envelope(type));

    expect(redis.xadd).toHaveBeenCalledTimes(PRODUCTION_TYPES.size);
  });

  it('publishes every type in shadow mode', async () => {
    const redis = makeRedis();
    const publisher = new RedisPublisher(redis, SERVER_ID, 'shadow');

    for (const type of ['player.damaged', 'chat.message', 'player.connected']) {
      await publisher.publishEvent(envelope(type));
    }

    expect(redis.xadd).toHaveBeenCalledTimes(3);
  });
});
