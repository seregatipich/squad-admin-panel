import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISCORD_COMMAND_DEFINITIONS,
  registerApplicationCommands,
} from '../src/command-registration.js';
import { loadDiscordBotContext } from '../src/role-sync.js';
import { runStatusChannelTick } from '../src/status-channel.js';
import { runStatusChannelLoop } from '../src/status-channel-loop.js';

vi.mock('../src/role-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/role-sync.js')>();
  return { ...actual, loadDiscordBotContext: vi.fn() };
});
vi.mock('../src/status-channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/status-channel.js')>();
  return { ...actual, runStatusChannelTick: vi.fn() };
});

const loadContextMock = vi.mocked(loadDiscordBotContext);
const tickMock = vi.mocked(runStatusChannelTick);

const silentLog = pino({ enabled: false });

const EMPTY_SUMMARY = {
  considered: 0,
  renamed: 0,
  unchanged: 0,
  rateLimited: 0,
  errors: 0,
};

function makeOpts(overrides: Record<string, unknown> = {}) {
  let iterations = 0;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the loop only forwards db into mocked helpers
    db: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: the loop only forwards redis into mocked helpers
    redis: {} as any,
    encryptionKey: Buffer.alloc(32, 0x42),
    fetchImpl: vi.fn() as unknown as typeof fetch,
    sleep: async () => undefined,
    log: silentLog,
    shouldStop: () => iterations++ >= 1,
    tickIntervalMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  loadContextMock.mockReset();
  tickMock.mockReset();
  tickMock.mockResolvedValue(EMPTY_SUMMARY);
});

describe('runStatusChannelLoop', () => {
  it('does nothing while the bot is not configured', async () => {
    loadContextMock.mockResolvedValue(null);

    await runStatusChannelLoop(makeOpts());

    expect(tickMock).not.toHaveBeenCalled();
  });

  it('ticks once the guild id and bot token are stored', async () => {
    loadContextMock.mockResolvedValue({ guildId: 'g1', botToken: 't1' });

    await runStatusChannelLoop(makeOpts());

    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it('keeps running when one tick throws', async () => {
    loadContextMock.mockResolvedValue({ guildId: 'g1', botToken: 't1' });
    tickMock.mockRejectedValueOnce(new Error('discord exploded'));
    let iterations = 0;

    await expect(
      runStatusChannelLoop(makeOpts({ shouldStop: () => iterations++ >= 2 })),
    ).resolves.toBeUndefined();

    expect(tickMock).toHaveBeenCalledTimes(2);
  });

  it('registers slash commands once when an application id is configured', async () => {
    loadContextMock.mockResolvedValue({ guildId: 'g1', botToken: 't1' });
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    let iterations = 0;

    await runStatusChannelLoop(
      makeOpts({
        applicationId: '500000000000000001',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        shouldStop: () => iterations++ >= 3,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/applications/500000000000000001/commands');
    expect(init.method).toBe('PUT');
  });

  it('does not touch the commands API without an application id', async () => {
    loadContextMock.mockResolvedValue({ guildId: 'g1', botToken: 't1' });
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));

    await runStatusChannelLoop(makeOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries command registration on the next tick after a failure', async () => {
    loadContextMock.mockResolvedValue({ guildId: 'g1', botToken: 't1' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 }))
      .mockResolvedValue(new Response('[]', { status: 200 }));
    let iterations = 0;

    await runStatusChannelLoop(
      makeOpts({
        applicationId: '500000000000000001',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        shouldStop: () => iterations++ >= 3,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('registerApplicationCommands', () => {
  it('declares exactly the three read-only commands and no mutating ones', () => {
    const names = DISCORD_COMMAND_DEFINITIONS.map((c) => c.name);
    expect(names).toEqual(['status', 'player', 'online-admins']);
    expect(names).not.toContain('ban');
    expect(names).not.toContain('kick');
  });

  it('PUTs the definitions with the bot authorization header', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const result = await registerApplicationCommands(
      {
        guildId: 'g1',
        botToken: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        log: silentLog,
      },
      '500000000000000001',
    );

    expect(result).toEqual({ ok: true, count: 3 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bot tok');
    expect(JSON.parse(init.body as string)).toHaveLength(3);
  });

  it('reports a rejection instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    const result = await registerApplicationCommands(
      {
        guildId: 'g1',
        botToken: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        log: silentLog,
      },
      '500000000000000001',
    );

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('reports a network failure instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('econnrefused');
    });
    const result = await registerApplicationCommands(
      {
        guildId: 'g1',
        botToken: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        log: silentLog,
      },
      '500000000000000001',
    );

    expect(result).toMatchObject({ ok: false, status: null });
  });
});
