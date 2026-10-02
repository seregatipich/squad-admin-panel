import dgram from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2sProbe } from '../src/supervisor/a2s-probe.js';
import type { SupervisorOptions, Target } from '../src/supervisor/types.js';

/**
 * #127: a game process that does not service its query port must show up as
 * "query unavailable" with the time of the last answer, never as
 * `visible: false`, which reads as a server that hides itself.
 */

function a2sReply(visibility: number): Buffer {
  const parts = [
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    Buffer.from('Deadline\0Gorodok\0squad\0Squad\0', 'utf8'),
    Buffer.from([0x00, 0x00, 42, 100, 0, 0x64, 0x6c, visibility]),
  ];
  return Buffer.concat(parts);
}

interface FakeRedis {
  store: Map<string, string>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeRedis(initial: Record<string, string> = {}): FakeRedis {
  const store = new Map(Object.entries(initial));
  return {
    store,
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

const sockets: dgram.Socket[] = [];
afterEach(() => {
  while (sockets.length) sockets.pop()?.close();
});

async function a2sServer(answer: { visibility: number } | null): Promise<number> {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  socket.on('message', (_msg, rinfo) => {
    if (answer) socket.send(a2sReply(answer.visibility), rinfo.port, rinfo.address);
  });
  return socket.address().port;
}

function makeProbe(redis: FakeRedis, queryPort: number, extra: Partial<Target> = {}) {
  const target: Target = {
    serverId: 'srv-a2s',
    host: '127.0.0.1',
    port: 21114,
    queryPort,
    password: 'pw',
    ...extra,
  };
  return new A2sProbe(target, { redis } as unknown as SupervisorOptions, 100);
}

const cached = (redis: FakeRedis) =>
  JSON.parse(redis.store.get('a2s:status:srv-a2s') ?? 'null') as Record<string, unknown> | null;

describe('A2sProbe cache entry', () => {
  it('stores the answer with visible and the time of the last success', async () => {
    const redis = makeRedis();
    const probe = makeProbe(redis, await a2sServer({ visibility: 0 }));
    await probe.probe();
    expect(cached(redis)).toMatchObject({
      visible: true,
      server_name: 'Deadline',
      map: 'Gorodok',
      players: 42,
      max_players: 100,
    });
    expect(cached(redis)?.last_success_at).toBe(cached(redis)?.queried_at);
  });

  it('keeps the last good answer for two misses, then reports the query as unavailable', async () => {
    const redis = makeRedis();
    const answering = await a2sServer({ visibility: 0 });
    await makeProbe(redis, answering).probe();
    const success = cached(redis);

    // Same probe object across ticks, so the failure counter carries over.
    const silentPort = await a2sServer(null);
    const probe = makeProbe(redis, silentPort);
    await probe.probe();
    await probe.probe();
    // Fewer than three misses: the earlier entry is untouched.
    expect(cached(redis)).toEqual(success);

    await probe.probe();
    const unavailable = cached(redis);
    expect(unavailable).toMatchObject({ visible: null, reason: 'timeout' });
    expect(unavailable).not.toHaveProperty('server_name');
    // A fresh probe never saw the answer itself: the time comes from the cached entry.
    expect(unavailable?.last_success_at).toBe(success?.last_success_at);
  });

  it('remembers its own last success across later misses', async () => {
    const redis = makeRedis();
    const port = await a2sServer({ visibility: 0 });
    const probe = makeProbe(redis, port);
    await probe.probe();
    const success = cached(redis)?.last_success_at;
    sockets.pop()?.close();
    redis.store.clear();

    await probe.probe();
    await probe.probe();
    await probe.probe();
    expect(cached(redis)).toMatchObject({
      visible: null,
      reason: 'timeout',
      last_success_at: success,
    });
  });

  it('never wrote an answer: unavailable with no last success, and never visible:false', async () => {
    const redis = makeRedis();
    const probe = makeProbe(redis, await a2sServer(null));
    for (let i = 0; i < 3; i++) await probe.probe();
    expect(cached(redis)).toMatchObject({
      visible: null,
      reason: 'timeout',
      last_success_at: null,
    });
  });

  it('still reports a server that answers and says it is not visible as visible:false', async () => {
    const redis = makeRedis();
    const probe = makeProbe(redis, await a2sServer({ visibility: 1 }));
    await probe.probe();
    expect(cached(redis)).toMatchObject({ visible: false });
    expect(cached(redis)).not.toHaveProperty('reason');
  });

  it('refuses an external host on loopback and says so', async () => {
    const redis = makeRedis();
    const probe = makeProbe(redis, await a2sServer({ visibility: 0 }), {
      refuseRestrictedAddresses: true,
    });
    for (let i = 0; i < 3; i++) await probe.probe();
    expect(cached(redis)).toMatchObject({ visible: null, reason: 'refused_address' });
  });
});
