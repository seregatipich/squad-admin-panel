import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../src/eventMap.js';
import { RedisPublisher } from '../src/redisPublisher.js';

interface FakeRedis {
  calls: { cmd: string; args: unknown[] }[];
  xadd: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

const fakeRedis = (): FakeRedis => {
  const calls: { cmd: string; args: unknown[] }[] = [];
  return {
    calls,
    xadd: vi.fn(async (...args: unknown[]) => {
      calls.push({ cmd: 'xadd', args });
      return '0-1';
    }),
    set: vi.fn(async (...args: unknown[]) => {
      calls.push({ cmd: 'set', args });
      return 'OK';
    }),
  };
};

const asRedis = (fake: FakeRedis): Redis => fake as unknown as Redis;

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const ENVELOPE: EventEnvelope = {
  id: 'evt',
  serverId: SERVER_ID,
  type: 'player.connected',
  version: 1,
  ts: '2026-04-24T10:00:00.000Z',
  payload: { steamId: 'A' },
};

describe('RedisPublisher (production mode)', () => {
  it('XADDs to events:server:{id} and SETs rcon:status:{id}', async () => {
    const r = fakeRedis();
    const pub = new RedisPublisher(asRedis(r), SERVER_ID, 'production');
    await pub.publishEvent(ENVELOPE);
    await pub.publishRconStatus({ state: 'connected', lastChange: '2026-04-24T10:00:00.000Z' });
    expect(r.calls[0]).toEqual({
      cmd: 'xadd',
      args: [`events:server:${SERVER_ID}`, '*', 'envelope', JSON.stringify(ENVELOPE)],
    });
    expect(r.calls[1].cmd).toBe('set');
    expect(r.calls[1].args[0]).toBe(`rcon:status:${SERVER_ID}`);
    expect(r.calls[1].args[2]).toBe('EX');
    expect(r.calls[1].args[3]).toBe(300);
  });
});

describe('RedisPublisher (shadow mode)', () => {
  it('writes to :shadow-suffixed keys instead', async () => {
    const r = fakeRedis();
    const pub = new RedisPublisher(asRedis(r), SERVER_ID, 'shadow');
    await pub.publishEvent(ENVELOPE);
    await pub.publishRconStatus({ state: 'connected', lastChange: '2026-04-24T10:00:00.000Z' });
    expect(r.calls[0].args[0]).toBe(`events:server:${SERVER_ID}:shadow`);
    expect(r.calls[1].args[0]).toBe(`rcon:status:${SERVER_ID}:shadow`);
  });
});
