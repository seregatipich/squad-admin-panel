import {
  chatCommandInvocations,
  serverCredentials,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM_ID = 76561198222075001n;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

// One app + database per file: every test seeds its own server (unique id and
// slug) and only reads or writes rows keyed by it.
beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterAll(async () => {
  await h?.cleanup();
});

/** Inserts a server + settings + credentials row and returns the server id. */
async function seedServer(slug: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Test ${slug}`,
    slug,
    status: 'stopped',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
    maxPlayers: 80,
    tickrate: 50,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return id;
}

describeIfDb('AUTO-4 chat-command settings + history', () => {
  it('PUT settings persists chat_commands_enabled and rules_text', async () => {
    const serverId = await seedServer('auto4-settings');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { chat_commands_enabled: false, rules_text: 'Не читерить.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { chat_commands_enabled: boolean; rules_text: string | null };
    expect(body.chat_commands_enabled).toBe(false);
    expect(body.rules_text).toBe('Не читерить.');

    const row = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    expect(row?.chatCommandsEnabled).toBe(false);
    expect(row?.rulesText).toBe('Не читерить.');
  });

  it('PUT settings clears rules_text with null and leaves the default enabled=true', async () => {
    const serverId = await seedServer('auto4-clear');
    const cookie = await loginAsOwner(h);

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rules_text: 'temp' },
    });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rules_text: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { chat_commands_enabled: boolean; rules_text: string | null };
    expect(body.rules_text).toBeNull();
    expect(body.chat_commands_enabled).toBe(true);
  });

  it('rejects a rules_text longer than the RCON single-message cap → 400', async () => {
    const serverId = await seedServer('auto4-toolong');
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rules_text: 'x'.repeat(301) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET server exposes chat_commands_enabled and rules_text in settings', async () => {
    const serverId = await seedServer('auto4-get');
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { chat_commands_enabled: false, rules_text: 'Читаемые правила' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      settings: { chat_commands_enabled: boolean; rules_text: string | null };
    };
    expect(body.settings.chat_commands_enabled).toBe(false);
    expect(body.settings.rules_text).toBe('Читаемые правила');
  });

  it('GET chat-commands returns invocation history, newest first, filterable by command', async () => {
    const serverId = await seedServer('auto4-history');
    const cookie = await loginAsOwner(h);

    await h.db.insert(chatCommandInvocations).values([
      {
        serverId,
        command: 'stats',
        args: '',
        responded: true,
        responseSource: 'rcon_warn',
        createdAt: new Date(Date.now() - 2000),
      },
      {
        serverId,
        command: 'report',
        args: 'BadGuy hacking',
        responded: true,
        responseSource: 'rcon_warn',
        createdAt: new Date(Date.now() - 1000),
      },
    ]);

    const all = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/chat-commands`,
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as {
      invocations: {
        command: string;
        args: string;
        responded: boolean;
        response_source: string | null;
        player_id: string | null;
      }[];
    };
    expect(allBody.invocations).toHaveLength(2);
    expect(allBody.invocations[0].command).toBe('report');
    expect(allBody.invocations[0].args).toBe('BadGuy hacking');
    expect(allBody.invocations[0].responded).toBe(true);
    expect(allBody.invocations[0].response_source).toBe('rcon_warn');
    expect(allBody.invocations[0].player_id).toBeNull();
    expect(allBody.invocations[1].command).toBe('stats');

    const filtered = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/chat-commands?command=report`,
      headers: { cookie },
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { invocations: { command: string }[] };
    expect(filteredBody.invocations).toHaveLength(1);
    expect(filteredBody.invocations[0].command).toBe('report');
  });

  it('GET chat-commands returns 404 for an unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/chat-commands`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET chat-commands returns 401 without authentication', async () => {
    const serverId = await seedServer('auto4-unauth');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/chat-commands`,
    });
    expect(res.statusCode).toBe(401);
  });
});
