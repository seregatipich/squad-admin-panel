import { createCipheriv, randomBytes } from 'node:crypto';
import {
  DISCORD_INTEGRATION_SINGLETON_ID,
  discordIntegration,
  discordRoleMappings,
  playerDiscordLinks,
  players,
} from '@squad/db/schema';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { EncryptedBlob } from '../src/crypto.js';
import {
  loadDiscordBotContext,
  type RoleSyncDeps,
  reconcileLinkedPlayers,
  syncPlayerDiscordRoles,
} from '../src/role-sync.js';

const GUILD_ID = '900000000000000001';
const BOT_TOKEN = 'fake-bot-token-for-tests-0011223344556677';

const PLAYER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PLAYER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ROLE_VIP = '11111111-1111-1111-1111-111111111111';
const ROLE_MOD = '22222222-2222-2222-2222-222222222222';
const DISCORD_ROLE_VIP = '700000000000000001';
const DISCORD_ROLE_MOD = '700000000000000002';
const DISCORD_USER_A = '800000000000000001';
const DISCORD_USER_B = '800000000000000002';

const silentLog = pino({ enabled: false });

interface FakeMapping {
  id: string;
  roleId: string;
  discordRoleId: string;
  enabled: boolean;
}

interface FakeLink {
  playerId: string;
  discordUserId: string;
}

interface FakePlayer {
  id: string;
  roleId: string | null;
}

interface FakeDbState {
  mappings: FakeMapping[];
  links: FakeLink[];
  players: FakePlayer[];
  integration?: {
    id: string;
    guildId: string | null;
    botTokenEncrypted: Buffer | null;
    enabled: boolean;
  } | null;
}

/**
 * Maps the drizzle columns `role-sync.ts` filters on to the corresponding key
 * on the fake rows below, so `where(eq(col, value))` is actually honoured
 * rather than ignored — without it the fake would hand `syncPlayerDiscordRoles`
 * another player's row and the "wrong player" bugs this suite exists to catch
 * would pass.
 */
const COLUMN_PROP = new Map<unknown, string>([
  [players.id, 'id'],
  [playerDiscordLinks.playerId, 'playerId'],
  [discordIntegration.id, 'id'],
]);

/** Extracts `(column, value)` out of a drizzle `eq()` condition. */
function conditionFilter(condition: unknown): (row: Record<string, unknown>) => boolean {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return () => true;
  const column = chunks.find((c) => COLUMN_PROP.has(c));
  const param = chunks.find(
    (c) => c != null && typeof c === 'object' && (c as object).constructor?.name === 'Param',
  ) as { value?: unknown } | undefined;
  const prop = COLUMN_PROP.get(column);
  if (!prop || param === undefined) return () => true;
  return (row) => row[prop] === param.value;
}

/**
 * Minimal drizzle stand-in covering exactly the query shapes `role-sync.ts`
 * issues: `select().from(t)`, `.where(cond)` and `.where(cond).limit(n)`.
 */
function makeFakeDb(state: FakeDbState) {
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (table === discordRoleMappings)
      return state.mappings as unknown as Record<string, unknown>[];
    if (table === playerDiscordLinks) return state.links as unknown as Record<string, unknown>[];
    if (table === players) return state.players as unknown as Record<string, unknown>[];
    if (table === discordIntegration) {
      return state.integration ? [state.integration as unknown as Record<string, unknown>] : [];
    }
    throw new Error('unexpected table in fake db select().from()');
  };
  const terminal = (table: unknown, rows: Record<string, unknown>[]) => {
    const promise = Promise.resolve(rows);
    return Object.assign(promise, {
      where: (condition: unknown) => terminal(table, rows.filter(conditionFilter(condition))),
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    });
  };
  return {
    select: () => ({ from: (table: unknown) => terminal(table, rowsFor(table)) }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake matching only what role-sync.ts calls
  } as any;
}

interface FakeGuildMember {
  roles: string[];
}

interface FakeDiscordOpts {
  members: Record<string, FakeGuildMember | 'not_found'>;
  /** Status returned by the role add/remove calls; 204 means success. */
  mutationStatus?: number;
  mutationBody?: unknown;
  /** When set, the first N mutation calls answer 429 with this Retry-After (seconds). */
  rateLimitFirst?: { count: number; retryAfterSeconds: number };
}

function makeFakeDiscord(opts: FakeDiscordOpts) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  let rateLimited = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ method, url, auth: headers.get('authorization') });

    if (method === 'GET') {
      const userId = url.split('/members/')[1] ?? '';
      const member = opts.members[userId];
      if (!member || member === 'not_found') {
        return new Response(JSON.stringify({ message: 'Unknown Member', code: 10007 }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ roles: member.roles }), { status: 200 });
    }

    const limit = opts.rateLimitFirst;
    if (limit && rateLimited < limit.count) {
      rateLimited++;
      return new Response(JSON.stringify({ retry_after: limit.retryAfterSeconds }), {
        status: 429,
        headers: { 'retry-after': String(limit.retryAfterSeconds) },
      });
    }
    const status = opts.mutationStatus ?? 204;
    return new Response(opts.mutationBody ? JSON.stringify(opts.mutationBody) : null, { status });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function makeDeps(
  state: FakeDbState,
  discord: ReturnType<typeof makeFakeDiscord>,
  sleep: (ms: number) => Promise<void> = async () => undefined,
): RoleSyncDeps {
  return {
    db: makeFakeDb(state),
    guildId: GUILD_ID,
    botToken: BOT_TOKEN,
    fetchImpl: discord.fetchImpl,
    sleep,
    log: silentLog,
  };
}

const BASE_STATE: FakeDbState = {
  mappings: [
    { id: 'm-vip', roleId: ROLE_VIP, discordRoleId: DISCORD_ROLE_VIP, enabled: true },
    { id: 'm-mod', roleId: ROLE_MOD, discordRoleId: DISCORD_ROLE_MOD, enabled: true },
  ],
  links: [
    { playerId: PLAYER_A, discordUserId: DISCORD_USER_A },
    { playerId: PLAYER_B, discordUserId: DISCORD_USER_B },
  ],
  players: [
    { id: PLAYER_A, roleId: ROLE_VIP },
    { id: PLAYER_B, roleId: null },
  ],
};

function stateWith(overrides: Partial<FakeDbState>): FakeDbState {
  return { ...BASE_STATE, ...overrides };
}

describe('syncPlayerDiscordRoles', () => {
  it('grants the mapped Discord role to a linked player who does not have it yet', async () => {
    const discord = makeFakeDiscord({ members: { [DISCORD_USER_A]: { roles: [] } } });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_A);

    expect(result.outcome).toBe('synced');
    expect(result.added).toEqual([DISCORD_ROLE_VIP]);
    expect(result.removed).toEqual([]);
    const mutation = discord.calls.find((c) => c.method === 'PUT');
    expect(mutation?.url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${DISCORD_USER_A}/roles/${DISCORD_ROLE_VIP}`,
    );
    expect(mutation?.auth).toBe(`Bot ${BOT_TOKEN}`);
  });

  it('revokes a managed Discord role the player’s new panel role no longer grants', async () => {
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [DISCORD_ROLE_MOD] } },
    });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_A);

    expect(result.added).toEqual([DISCORD_ROLE_VIP]);
    expect(result.removed).toEqual([DISCORD_ROLE_MOD]);
    expect(
      discord.calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url ===
            `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${DISCORD_USER_A}/roles/${DISCORD_ROLE_MOD}`,
      ),
    ).toBe(true);
  });

  it('revokes every managed role when the panel role is removed', async () => {
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_B]: { roles: [DISCORD_ROLE_VIP, DISCORD_ROLE_MOD] } },
    });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_B);

    expect(result.added).toEqual([]);
    expect(result.removed.sort()).toEqual([DISCORD_ROLE_VIP, DISCORD_ROLE_MOD].sort());
  });

  it('never touches a Discord role that no mapping governs', async () => {
    const unmanaged = '799999999999999999';
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [unmanaged, DISCORD_ROLE_VIP] } },
    });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_A);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(discord.calls.every((c) => !c.url.includes(unmanaged))).toBe(true);
  });

  it('ignores a disabled mapping in both directions', async () => {
    const state = stateWith({
      mappings: [
        { id: 'm-vip', roleId: ROLE_VIP, discordRoleId: DISCORD_ROLE_VIP, enabled: false },
      ],
    });
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [DISCORD_ROLE_VIP] } },
    });
    const result = await syncPlayerDiscordRoles(makeDeps(state, discord), PLAYER_A);

    expect(result.outcome).toBe('synced');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(discord.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('is a no-op for a player with no Discord link and makes no Discord call', async () => {
    const state = stateWith({ links: [] });
    const discord = makeFakeDiscord({ members: {} });
    const result = await syncPlayerDiscordRoles(makeDeps(state, discord), PLAYER_A);

    expect(result.outcome).toBe('not_linked');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(discord.calls).toEqual([]);
  });

  it('is a no-op for a linked player who is not a member of the guild', async () => {
    const discord = makeFakeDiscord({ members: { [DISCORD_USER_A]: 'not_found' } });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_A);

    expect(result.outcome).toBe('not_a_guild_member');
    expect(discord.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reports missing_permissions instead of failing silently when the bot lacks Manage Roles', async () => {
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [] } },
      mutationStatus: 403,
      mutationBody: { message: 'Missing Permissions', code: 50013 },
    });
    const result = await syncPlayerDiscordRoles(makeDeps(BASE_STATE, discord), PLAYER_A);

    expect(result.outcome).toBe('error');
    expect(result.error).toEqual({
      reason: 'missing_permissions',
      message: 'У бота нет права Manage Roles в Discord-гильдии.',
    });
    expect(result.added).toEqual([]);
  });

  it('retries a rate-limited role grant after the advertised Retry-After delay', async () => {
    const waits: number[] = [];
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [] } },
      rateLimitFirst: { count: 1, retryAfterSeconds: 2 },
    });
    const result = await syncPlayerDiscordRoles(
      makeDeps(BASE_STATE, discord, async (ms) => {
        waits.push(ms);
      }),
      PLAYER_A,
    );

    expect(result.outcome).toBe('synced');
    expect(result.added).toEqual([DISCORD_ROLE_VIP]);
    expect(waits).toEqual([2000]);
    expect(discord.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });
});

describe('reconcileLinkedPlayers', () => {
  it('restores a Discord role that was removed by hand — the panel is the source of truth', async () => {
    const discord = makeFakeDiscord({
      members: {
        [DISCORD_USER_A]: { roles: [] },
        [DISCORD_USER_B]: { roles: [] },
      },
    });
    const summary = await reconcileLinkedPlayers(makeDeps(BASE_STATE, discord));

    expect(summary.checked).toBe(2);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(0);
    expect(
      discord.calls.some(
        (c) =>
          c.method === 'PUT' &&
          c.url.endsWith(`/members/${DISCORD_USER_A}/roles/${DISCORD_ROLE_VIP}`),
      ),
    ).toBe(true);
  });

  it('strips a managed Discord role that was granted by hand outside the panel', async () => {
    const discord = makeFakeDiscord({
      members: {
        [DISCORD_USER_A]: { roles: [DISCORD_ROLE_VIP] },
        [DISCORD_USER_B]: { roles: [DISCORD_ROLE_MOD] },
      },
    });
    const summary = await reconcileLinkedPlayers(makeDeps(BASE_STATE, discord));

    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(1);
    expect(
      discord.calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url.endsWith(`/members/${DISCORD_USER_B}/roles/${DISCORD_ROLE_MOD}`),
      ),
    ).toBe(true);
  });

  it('counts a guild-membership gap as skipped and keeps going', async () => {
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: 'not_found', [DISCORD_USER_B]: { roles: [] } },
    });
    const summary = await reconcileLinkedPlayers(makeDeps(BASE_STATE, discord));

    expect(summary.checked).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it('surfaces the first missing-permissions failure rather than swallowing it', async () => {
    const discord = makeFakeDiscord({
      members: { [DISCORD_USER_A]: { roles: [] }, [DISCORD_USER_B]: { roles: [] } },
      mutationStatus: 403,
      mutationBody: { message: 'Missing Permissions', code: 50013 },
    });
    const summary = await reconcileLinkedPlayers(makeDeps(BASE_STATE, discord));

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toEqual({
      reason: 'missing_permissions',
      message: 'У бота нет права Manage Roles в Discord-гильдии.',
    });
  });
});

describe('loadDiscordBotContext', () => {
  const key = Buffer.alloc(32, 0x42);

  /** Mirrors the API's `encrypt()` + `serialize()` the same way `test/sender.test.ts` does. */
  function encryptToken(token: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()]);
    const blob: EncryptedBlob = {
      v: 1,
      kv: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
    return Buffer.from(JSON.stringify(blob), 'utf-8');
  }

  it('decrypts the stored bot token when the integration is fully configured', async () => {
    const db = makeFakeDb(
      stateWith({
        integration: {
          id: DISCORD_INTEGRATION_SINGLETON_ID,
          guildId: GUILD_ID,
          botTokenEncrypted: encryptToken(BOT_TOKEN),
          enabled: true,
        },
      }),
    );
    expect(await loadDiscordBotContext(db, key)).toEqual({
      guildId: GUILD_ID,
      botToken: BOT_TOKEN,
    });
  });

  it('returns null when the integration row is absent', async () => {
    const db = makeFakeDb(stateWith({ integration: null }));
    expect(await loadDiscordBotContext(db, key)).toBeNull();
  });

  it('returns null when the integration is disabled', async () => {
    const db = makeFakeDb(
      stateWith({
        integration: {
          id: DISCORD_INTEGRATION_SINGLETON_ID,
          guildId: GUILD_ID,
          botTokenEncrypted: Buffer.from('x'),
          enabled: false,
        },
      }),
    );
    expect(await loadDiscordBotContext(db, key)).toBeNull();
  });

  it('returns null when the guild id is missing', async () => {
    const db = makeFakeDb(
      stateWith({
        integration: {
          id: DISCORD_INTEGRATION_SINGLETON_ID,
          guildId: null,
          botTokenEncrypted: Buffer.from('x'),
          enabled: true,
        },
      }),
    );
    expect(await loadDiscordBotContext(db, key)).toBeNull();
  });

  it('returns null when no bot token is stored', async () => {
    const db = makeFakeDb(
      stateWith({
        integration: {
          id: DISCORD_INTEGRATION_SINGLETON_ID,
          guildId: GUILD_ID,
          botTokenEncrypted: null,
          enabled: true,
        },
      }),
    );
    expect(await loadDiscordBotContext(db, key)).toBeNull();
  });
});
