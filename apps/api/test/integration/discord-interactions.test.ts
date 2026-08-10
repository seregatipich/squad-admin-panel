import { generateKeyPairSync, sign } from 'node:crypto';
import { auditLog, playerDiscordLinks, players, roles, servers } from '@squad/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { rawEd25519PublicKeyHex } from '../../src/lib/discord-interactions.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

/**
 * DISCORD-6 (#153): the slash-command half. Interactions arrive over Discord's
 * HTTP transport, so the whole path — Ed25519 signature, link + panel_access
 * gate, ephemeral answers, audit — is exercised here against the real route.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const EPHEMERAL = 64;
const PONG = 1;
const CHANNEL_MESSAGE = 4;

const ADMIN_STEAM = testSteamId(992010);
const NOACCESS_STEAM = testSteamId(992011);
const TARGET_STEAM = testSteamId(992012);

const ADMIN_DISCORD_ID = '800000000000000101';
const NOACCESS_DISCORD_ID = '800000000000000102';
const UNLINKED_DISCORD_ID = '800000000000000103';

const URL = '/api/v1/integrations/discord/interactions';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = rawEd25519PublicKeyHex(publicKey);

let h: IntegrationHarness;
let adminPlayerId: string;
let targetPlayerId: string;
let serverId: string;

function signedInject(body: unknown, overrides: { signature?: string; timestamp?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides.signature ??
    sign(null, Buffer.from(timestamp + rawBody, 'utf8'), privateKey).toString('hex');
  return h.app.inject({
    method: 'POST',
    url: URL,
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    payload: rawBody,
  });
}

function command(name: string, discordUserId: string, options: unknown[] = []) {
  return {
    type: 2,
    id: '1',
    application_id: '2',
    token: 'interaction-token',
    data: { id: '3', name, options },
    member: { user: { id: discordUserId, username: 'tester' } },
  };
}

describeIfDb('POST /api/v1/integrations/discord/interactions', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: ADMIN_STEAM },
      bridge: makeFakeBridge(),
      discordInteractionsPublicKey: PUBLIC_KEY_HEX,
    });
    adminPlayerId = h.seed.ownerPlayerId as string;

    const noAccessRoleId = uuidv7();
    await h.db.insert(roles).values({
      id: noAccessRoleId,
      name: 'discord-cmd-noaccess',
      color: 'sky',
      panelAccess: false,
    });
    const [noAccess] = await h.db
      .insert(players)
      .values({
        steamId64: NOACCESS_STEAM,
        canonicalName: 'DiscordCmdNoAccess',
        canonicalNameNormalized: 'discordcmdnoaccess',
        roleId: noAccessRoleId,
      })
      .returning({ id: players.id });
    const [target] = await h.db
      .insert(players)
      .values({
        steamId64: TARGET_STEAM,
        canonicalName: 'DiscordCmdTarget',
        canonicalNameNormalized: 'discordcmdtarget',
      })
      .returning({ id: players.id });
    targetPlayerId = target?.id as string;

    await h.db.insert(playerDiscordLinks).values([
      { playerId: adminPlayerId, discordUserId: ADMIN_DISCORD_ID, discordUsername: 'admin#1' },
      {
        playerId: noAccess?.id as string,
        discordUserId: NOACCESS_DISCORD_ID,
        discordUsername: 'noaccess#1',
      },
    ]);

    serverId = uuidv7();
    await h.db.insert(servers).values({
      id: serverId,
      displayName: 'Interactions Test',
      slug: `interactions-${serverId}`,
    });
    invalidateAllPermissionCaches();
  }, 60_000);

  afterAll(async () => {
    invalidateAllPermissionCaches();
    await h.redis.del(`rcon:status:${serverId}`, `rcon:roster:${serverId}`);
    await h.cleanup();
  }, 60_000);

  beforeEach(async () => {
    // Own the cache keys this suite reads: clear them at the top of setup so a
    // previous test's roster never leaks into the next assertion.
    await h.redis.del(`rcon:status:${serverId}`, `rcon:roster:${serverId}`);
  });

  it('answers Discord PING with PONG', async () => {
    const res = await signedInject({ type: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: PONG });
  });

  it('rejects an interaction whose signature does not verify', async () => {
    const res = await signedInject({ type: 1 }, { signature: '00'.repeat(64) });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an interaction with no signature headers at all', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses /status from a Discord account that is not linked, with a linking hint', async () => {
    const res = await signedInject(command('status', UNLINKED_DISCORD_ID));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(CHANNEL_MESSAGE);
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain('привяж');
  });

  it('refuses /status from a linked player whose role has no panel access', async () => {
    const res = await signedInject(command('status', NOACCESS_DISCORD_ID));

    const body = res.json() as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain('доступ');
  });

  it('answers /status with the live map, players and queue, ephemerally', async () => {
    await h.redis.set(
      `rcon:status:${serverId}`,
      JSON.stringify({
        state: 'connected',
        current_map: 'Gorodok_RAAS_v1',
        player_count: 78,
        public_queue: 4,
      }),
      'EX',
      300,
    );

    const res = await signedInject(command('status', ADMIN_DISCORD_ID));

    const body = res.json() as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(CHANNEL_MESSAGE);
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain('Gorodok_RAAS_v1');
    expect(body.data.content).toContain('78');
    expect(body.data.content).toContain('4');
  });

  it('finds a player by name and links to the panel page', async () => {
    const res = await signedInject(
      command('player', ADMIN_DISCORD_ID, [{ name: 'query', value: 'DiscordCmdTarget' }]),
    );

    const body = res.json() as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain('DiscordCmdTarget');
    expect(body.data.content).toContain(`https://panel.test/players/${targetPlayerId}`);
  });

  it('finds the same player by steam_id64', async () => {
    const res = await signedInject(
      command('player', ADMIN_DISCORD_ID, [{ name: 'query', value: TARGET_STEAM.toString() }]),
    );

    const body = res.json() as { data: { content: string } };
    expect(body.data.content).toContain('DiscordCmdTarget');
    expect(body.data.content).toContain(`https://panel.test/players/${targetPlayerId}`);
  });

  it('reports no match for an unknown player query', async () => {
    const res = await signedInject(
      command('player', ADMIN_DISCORD_ID, [{ name: 'query', value: 'nobody-by-that-name-xyz' }]),
    );

    const body = res.json() as { data: { content: string } };
    expect(body.data.content).toContain('не найден');
  });

  it('lists only roster players whose role grants panel access for /online-admins', async () => {
    await h.redis.set(
      `rcon:roster:${serverId}`,
      JSON.stringify({
        server_id: serverId,
        polled_at: new Date().toISOString(),
        players: [
          { steam_id64: ADMIN_STEAM.toString(), name: 'AdminOnline' },
          { steam_id64: TARGET_STEAM.toString(), name: 'DiscordCmdTarget' },
        ],
      }),
      'EX',
      90,
    );

    const res = await signedInject(command('online-admins', ADMIN_DISCORD_ID));

    const body = res.json() as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain('AdminOnline');
    expect(body.data.content).not.toContain('DiscordCmdTarget');
  });

  it('writes an audit row with the linked player as actor for every command', async () => {
    const cases: Array<[string, string]> = [
      ['status', 'discord.command.status'],
      ['online-admins', 'discord.command.online_admins'],
    ];
    for (const [name, actionType] of cases) {
      await signedInject(command(name, ADMIN_DISCORD_ID));
      const [row] = await h.db
        .select({ actorPlayerId: auditLog.actorPlayerId, actorKind: auditLog.actorKind })
        .from(auditLog)
        .where(and(eq(auditLog.actionType, actionType), eq(auditLog.actorPlayerId, adminPlayerId)))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect(row, `expected an audit row for ${actionType}`).toBeDefined();
      expect(row?.actorKind).toBe('steam');
    }
  });

  it('does not audit a refused command from an unlinked account', async () => {
    const before = await h.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actionType, 'discord.command.status'));

    await signedInject(command('status', UNLINKED_DISCORD_ID));

    const after = await h.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actionType, 'discord.command.status'));
    expect(after.length).toBe(before.length);
  });

  it('answers an unknown command name without crashing', async () => {
    const res = await signedInject(command('definitely-not-a-command', ADMIN_DISCORD_ID));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(EPHEMERAL);
  });
});
