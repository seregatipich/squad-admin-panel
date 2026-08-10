import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  addGuildMemberRole,
  DISCORD_API_BASE,
  type DiscordRestDeps,
  fetchGuildMemberRoles,
  removeGuildMemberRole,
} from '../src/discord-rest.js';

const GUILD_ID = '900000000000000001';
const BOT_TOKEN = 'fake-bot-token-for-tests-0011223344556677';
const USER_ID = '800000000000000001';
const ROLE_ID = '700000000000000001';

const silentLog = pino({ enabled: false });

function makeDeps(
  fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>,
  sleep: (ms: number) => Promise<void> = async () => undefined,
): DiscordRestDeps {
  return {
    guildId: GUILD_ID,
    botToken: BOT_TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    log: silentLog,
  };
}

describe('addGuildMemberRole / removeGuildMemberRole', () => {
  it('PUTs and DELETEs the documented guild-member role endpoint', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const deps = makeDeps(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(null, { status: 204 });
    });

    expect(await addGuildMemberRole(deps, USER_ID, ROLE_ID)).toEqual({ ok: true });
    expect(await removeGuildMemberRole(deps, USER_ID, ROLE_ID)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: `${DISCORD_API_BASE}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}`,
        method: 'PUT',
      },
      {
        url: `${DISCORD_API_BASE}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}`,
        method: 'DELETE',
      },
    ]);
  });

  it('reports a network error rather than throwing out of the sync', async () => {
    const deps = makeDeps(async () => {
      throw new Error('ECONNRESET');
    });
    const res = await addGuildMemberRole(deps, USER_ID, ROLE_ID);
    expect(res).toEqual({
      ok: false,
      failure: { reason: 'network_error', message: 'Discord недоступен: ECONNRESET' },
    });
  });

  it('reports a non-403 error status verbatim', async () => {
    const deps = makeDeps(async () => new Response('boom', { status: 500 }));
    const res = await addGuildMemberRole(deps, USER_ID, ROLE_ID);
    expect(res).toEqual({
      ok: false,
      failure: { reason: 'http_error', message: 'Discord вернул 500' },
    });
  });

  it('falls back to a default wait when a 429 carries no retry hint', async () => {
    const waits: number[] = [];
    let first = true;
    const deps = makeDeps(
      async () => {
        if (first) {
          first = false;
          return new Response('not json', { status: 429 });
        }
        return new Response(null, { status: 204 });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(await addGuildMemberRole(deps, USER_ID, ROLE_ID)).toEqual({ ok: true });
    expect(waits).toEqual([1000]);
  });

  it('reads the retry delay from the JSON body when the header is absent', async () => {
    const waits: number[] = [];
    let first = true;
    const deps = makeDeps(
      async () => {
        if (first) {
          first = false;
          return new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 });
        }
        return new Response(null, { status: 204 });
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(await addGuildMemberRole(deps, USER_ID, ROLE_ID)).toEqual({ ok: true });
    expect(waits).toEqual([500]);
  });

  it('gives up after repeated 429s instead of retrying forever', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429 }));
    const deps = makeDeps(fetchImpl, async () => undefined);

    const res = await addGuildMemberRole(deps, USER_ID, ROLE_ID);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure.reason).toBe('rate_limited');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});

describe('fetchGuildMemberRoles', () => {
  it('returns the member’s current role ids', async () => {
    const deps = makeDeps(
      async () => new Response(JSON.stringify({ roles: [ROLE_ID, 7, null] }), { status: 200 }),
    );
    expect(await fetchGuildMemberRoles(deps, USER_ID)).toEqual({ ok: true, roles: [ROLE_ID] });
  });

  it('treats a 404 as "not in the guild" rather than an error', async () => {
    const deps = makeDeps(async () => new Response(null, { status: 404 }));
    expect(await fetchGuildMemberRoles(deps, USER_ID)).toEqual({ ok: false, notAMember: true });
  });

  it('maps a 403 to the missing-permissions failure', async () => {
    const deps = makeDeps(async () => new Response(null, { status: 403 }));
    expect(await fetchGuildMemberRoles(deps, USER_ID)).toEqual({
      ok: false,
      notAMember: false,
      failure: {
        reason: 'missing_permissions',
        message: 'У бота нет права Manage Roles в Discord-гильдии.',
      },
    });
  });

  it('reports any other error status', async () => {
    const deps = makeDeps(async () => new Response(null, { status: 502 }));
    expect(await fetchGuildMemberRoles(deps, USER_ID)).toEqual({
      ok: false,
      notAMember: false,
      failure: { reason: 'http_error', message: 'Discord вернул 502' },
    });
  });

  it('reports an unreadable body instead of throwing', async () => {
    const deps = makeDeps(async () => new Response('not json', { status: 200 }));
    const res = await fetchGuildMemberRoles(deps, USER_ID);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.notAMember === false && res.failure.reason).toBe('http_error');
  });

  it('reports a network error instead of throwing', async () => {
    const deps = makeDeps(async () => {
      throw new Error('EAI_AGAIN');
    });
    expect(await fetchGuildMemberRoles(deps, USER_ID)).toEqual({
      ok: false,
      notAMember: false,
      failure: { reason: 'network_error', message: 'Discord недоступен: EAI_AGAIN' },
    });
  });

  it('sends the bot authorization header', async () => {
    let auth: string | null = null;
    const deps = makeDeps(async (_input, init) => {
      auth = new Headers((init?.headers ?? {}) as HeadersInit).get('authorization');
      return new Response(JSON.stringify({ roles: [] }), { status: 200 });
    });
    await fetchGuildMemberRoles(deps, USER_ID);
    expect(auth).toBe(`Bot ${BOT_TOKEN}`);
  });
});
