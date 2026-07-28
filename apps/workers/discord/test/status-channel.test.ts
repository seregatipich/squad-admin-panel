import { players, servers } from '@squad/db/schema';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { StatusChannelDeps } from '../src/status-channel.js';
import {
  buildStatusChannelName,
  countOnlineAdmins,
  parseRosterCache,
  parseStatusCache,
  renameStatusChannel,
  runStatusChannelTick,
  STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW,
  STATUS_CHANNEL_RENAME_WINDOW_MS,
} from '../src/status-channel.js';

const silentLog = pino({ enabled: false });

const GUILD_ID = '900000000000000001';
const BOT_TOKEN = 'fake-bot-token-for-tests-0011223344556677';
const CHANNEL_ID = '600000000000000001';
const SERVER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** Minimal in-memory stand-in for the two Redis commands the tick uses. */
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

/**
 * Fake drizzle builder. `runStatusChannelTick` issues exactly two shapes of
 * query and they are told apart by the table handed to `.from()`, so the fake
 * honours the query instead of returning one canned array for everything.
 *
 * Both queries end in `.where()`, so that is the awaited step; a future query
 * that appends `.orderBy()` or `.limit()` fails loudly here rather than
 * silently reading an empty result.
 */
function fakeDb(rows: { servers?: unknown[]; admins?: unknown[] }) {
  return {
    select() {
      let table: unknown = null;
      const chain = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where(): Promise<unknown[]> {
          if (table === servers) return Promise.resolve(rows.servers ?? []);
          if (table === players) return Promise.resolve(rows.admins ?? []);
          return Promise.resolve([]);
        },
      };
      return chain;
    },
  };
}

function makeDeps(over: Partial<StatusChannelDeps> = {}): StatusChannelDeps {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fake exposes only the builder shape the tick uses
    db: fakeDb({}) as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
    redis: fakeRedis() as any,
    guildId: GUILD_ID,
    botToken: BOT_TOKEN,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    sleep: async () => undefined,
    log: silentLog,
    now: () => 1_000_000,
    ...over,
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: CHANNEL_ID }), { status: 200 });
}

describe('buildStatusChannelName', () => {
  it('renders the SQSTAT §16.3 template from a connected status snapshot', () => {
    const name = buildStatusChannelName(
      { state: 'connected', current_map: 'Gorodok_RAAS_v1', player_count: 100, public_queue: 7 },
      2,
    );
    expect(name).toBe('🟢gorodok_100x7_👮2');
  });

  it('marks a server that is not connected with the offline emoji', () => {
    const name = buildStatusChannelName(
      { state: 'disconnected', current_map: 'Gorodok_RAAS_v1', player_count: 100 },
      1,
    );
    expect(name.startsWith('🔴')).toBe(true);
  });

  it('falls back to zeroes and an offline marker when no status is cached', () => {
    expect(buildStatusChannelName(null, 0)).toBe('🔴unknown_0x0_👮0');
  });

  it('treats a missing public_queue as an empty queue rather than dropping the field', () => {
    const name = buildStatusChannelName(
      { state: 'connected', current_map: 'Yehorivka_AAS_v1', player_count: 42 },
      0,
    );
    expect(name).toBe('🟢yehorivka_42x0_👮0');
  });

  it('keeps the generated name inside the Discord 100-character channel-name limit', () => {
    const name = buildStatusChannelName(
      {
        state: 'connected',
        current_map: `${'VeryLongMapName'.repeat(20)}_RAAS_v1`,
        player_count: 100,
        public_queue: 7,
      },
      2,
    );
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe('countOnlineAdmins', () => {
  it('counts only roster players whose steam id has panel access', () => {
    const roster = parseRosterCache(
      JSON.stringify({
        server_id: SERVER_ID,
        polled_at: new Date().toISOString(),
        players: [
          { steam_id64: '76561197999992001', name: 'AdminOne' },
          { steam_id64: '76561197999992002', name: 'Regular' },
          { steam_id64: null, name: 'NoSteamId' },
        ],
      }),
    );
    const admins = new Set(['76561197999992001', '76561197999992999']);
    expect(countOnlineAdmins(roster, admins)).toBe(1);
  });

  it('counts zero when the roster cache is missing or unparseable', () => {
    expect(countOnlineAdmins(parseRosterCache(null), new Set(['76561197999992001']))).toBe(0);
    expect(countOnlineAdmins(parseRosterCache('{not json'), new Set())).toBe(0);
  });
});

describe('parseStatusCache', () => {
  it('returns null for missing and malformed cache entries', () => {
    expect(parseStatusCache(null)).toBeNull();
    expect(parseStatusCache('{not json')).toBeNull();
  });

  it('reads the public_queue field worker-rcon writes alongside player_count', () => {
    const parsed = parseStatusCache(
      JSON.stringify({ state: 'connected', player_count: 80, public_queue: 5 }),
    );
    expect(parsed).toMatchObject({ state: 'connected', player_count: 80, public_queue: 5 });
  });
});

describe('renameStatusChannel', () => {
  it('PATCHes the channel and records the new name on first run', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const redis = fakeRedis();
    const deps = makeDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
    });

    const outcome = await renameStatusChannel(deps, CHANNEL_ID, '🟢gorodok_100x7_👮2');

    expect(outcome).toBe('renamed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL_ID}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: '🟢gorodok_100x7_👮2' });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bot ${BOT_TOKEN}`);
  });

  it('issues no request at all when the name has not changed', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const redis = fakeRedis();
    const deps = makeDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
    });

    await renameStatusChannel(deps, CHANNEL_ID, '🟢gorodok_100x7_👮2');
    const outcome = await renameStatusChannel(deps, CHANNEL_ID, '🟢gorodok_100x7_👮2');

    expect(outcome).toBe('unchanged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never exceeds two renames per ten minutes on one channel', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const redis = fakeRedis();
    let clock = 1_000_000;
    const deps = makeDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
      now: () => clock,
    });

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      outcomes.push(await renameStatusChannel(deps, CHANNEL_ID, `🟢gorodok_${i}x0_👮0`));
    }

    expect(fetchImpl.mock.calls.length).toBe(STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW);
    expect(outcomes.filter((o) => o === 'renamed')).toHaveLength(
      STATUS_CHANNEL_MAX_RENAMES_PER_WINDOW,
    );
    expect(outcomes.filter((o) => o === 'rate_limited')).toHaveLength(3);
  });

  it('renames again once the ten-minute window has rolled past', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const redis = fakeRedis();
    let clock = 1_000_000;
    const deps = makeDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
      now: () => clock,
    });

    await renameStatusChannel(deps, CHANNEL_ID, 'name-a');
    await renameStatusChannel(deps, CHANNEL_ID, 'name-b');
    clock += 1000;
    expect(await renameStatusChannel(deps, CHANNEL_ID, 'name-c')).toBe('rate_limited');

    clock += STATUS_CHANNEL_RENAME_WINDOW_MS + 1;
    expect(await renameStatusChannel(deps, CHANNEL_ID, 'name-c')).toBe('renamed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not consume rename budget when Discord rejects the request', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    const redis = fakeRedis();
    const deps = makeDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
    });

    expect(await renameStatusChannel(deps, CHANNEL_ID, 'name-a')).toBe('error');
    expect(await renameStatusChannel(deps, CHANNEL_ID, 'name-a')).toBe('error');
    expect(await renameStatusChannel(deps, CHANNEL_ID, 'name-a')).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('runStatusChannelTick', () => {
  it('skips servers that have no status channel configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const deps = makeDeps({
      // biome-ignore lint/suspicious/noExplicitAny: fake builder
      db: fakeDb({ servers: [], admins: [] }) as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const summary = await runStatusChannelTick(deps);

    expect(summary).toMatchObject({ considered: 0, renamed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renames the configured channel to the live status of its server', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const redis = fakeRedis({
      [`rcon:status:${SERVER_ID}`]: JSON.stringify({
        state: 'connected',
        current_map: 'Gorodok_RAAS_v1',
        player_count: 100,
        public_queue: 7,
      }),
      [`rcon:roster:${SERVER_ID}`]: JSON.stringify({
        server_id: SERVER_ID,
        polled_at: new Date().toISOString(),
        players: [
          { steam_id64: '76561197999992001', name: 'AdminOne' },
          { steam_id64: '76561197999992500', name: 'Regular' },
        ],
      }),
    });
    const deps = makeDeps({
      db: fakeDb({
        servers: [{ id: SERVER_ID, statusChannelId: CHANNEL_ID }],
        admins: [{ steamId64: 76561197999992001n }],
        // biome-ignore lint/suspicious/noExplicitAny: fake builder
      }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: fake exposes only get/set
      redis: redis as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const summary = await runStatusChannelTick(deps);

    expect(summary).toMatchObject({ considered: 1, renamed: 1 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: '🟢gorodok_100x7_👮1' });
  });

  it('reports a server whose status cache has expired as offline instead of skipping it', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const deps = makeDeps({
      db: fakeDb({
        servers: [{ id: SERVER_ID, statusChannelId: CHANNEL_ID }],
        admins: [],
        // biome-ignore lint/suspicious/noExplicitAny: fake builder
      }) as any,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const summary = await runStatusChannelTick(deps);

    expect(summary).toMatchObject({ considered: 1, renamed: 1 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: '🔴unknown_0x0_👮0' });
  });
});
