import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auditLog, discordIntegration, discordWebhooks, players, roles } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptString, deserialize, encrypt, serialize } from '../../src/lib/crypto.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

interface FakeDiscordServer {
  url: string;
  close: () => Promise<void>;
}

/** Spins up a local HTTP listener that stands in for a Discord webhook endpoint. */
async function startFakeDiscordServer(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<FakeDiscordServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const OWNER_STEAM = testSteamId(910001);
const MODERATOR_STEAM = testSteamId(910002);

const TEST_KEY = Buffer.alloc(32, 0x42);

const WEBHOOK_TOKEN = 'Th1s_Is-A_FakeToken_ForTests_00112233445566778899aabbccddeeff';
const WEBHOOK_URL = `https://discord.com/api/webhooks/112233445566778899/${WEBHOOK_TOKEN}`;
const BOT_TOKEN = 'fake-bot-token-fixture-do-not-use-0011223344556677';

let h: IntegrationHarness;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'discord-integration-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  const [moderatorRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Moderator'))
    .limit(1);
  if (!moderatorRole) throw new Error('Moderator role missing — seed migration not applied?');

  const name = 'ModPlayer';
  await h.db
    .insert(players)
    .values({
      steamId64: MODERATOR_STEAM,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId: moderatorRole.id,
    })
    .onConflictDoNothing();
  invalidateAllPermissionCaches();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('Discord integration — RBAC gating', () => {
  const endpoints: Array<{ method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string }> = [
    { method: 'GET', url: '/api/v1/integrations/discord' },
    { method: 'PUT', url: '/api/v1/integrations/discord' },
    { method: 'GET', url: '/api/v1/integrations/discord/webhooks' },
    { method: 'POST', url: '/api/v1/integrations/discord/webhooks' },
    {
      method: 'PUT',
      url: '/api/v1/integrations/discord/webhooks/00000000-0000-0000-0000-000000000abc',
    },
    {
      method: 'DELETE',
      url: '/api/v1/integrations/discord/webhooks/00000000-0000-0000-0000-000000000abc',
    },
  ];

  it('rejects unauthenticated requests with 401 on every endpoint', async () => {
    for (const ep of endpoints) {
      const res = await h.app.inject({ method: ep.method, url: ep.url, payload: '{}' });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it('rejects users without can_manage_integrations with 403 on every endpoint', async () => {
    const cookie = await loginAsSteam(MODERATOR_STEAM);
    for (const ep of endpoints) {
      const res = await h.app.inject({
        method: ep.method,
        url: ep.url,
        headers: { cookie, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('allows the Owner (integration:manage derived) to read settings', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, bot_token_configured: false });
  });
});

describeIfDb('Discord integration — masking + at-rest encryption', () => {
  it('PUT integration stores an encrypted bot token and never returns it', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/discord',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        guild_id: '123456789012345678',
        enabled: true,
        bot_token: BOT_TOKEN,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(BOT_TOKEN);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      guild_id: '123456789012345678',
      enabled: true,
      bot_token_configured: true,
      bot_token_mask: '****',
    });
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);

    const [row] = await h.db.select().from(discordIntegration).limit(1);
    if (!row?.botTokenEncrypted) throw new Error('integration row missing encrypted bot token');
    const stored = Buffer.from(row.botTokenEncrypted as unknown as Buffer);
    expect(stored.toString('utf-8')).not.toContain(BOT_TOKEN);
    expect(decryptString(TEST_KEY, deserialize(stored))).toBe(BOT_TOKEN);
  });

  it('GET integration never leaks the bot token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(BOT_TOKEN);
    expect(res.json()).toMatchObject({ bot_token_configured: true, bot_token_mask: '****' });
  });

  it('POST webhook returns only a masked url and stores it encrypted', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        event_type: 'ban_issued',
        webhook_url: WEBHOOK_URL,
        channel_label: '#bans',
        mention_everyone: true,
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(WEBHOOK_TOKEN);
    expect(res.body).not.toContain(WEBHOOK_URL);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      event_type: 'ban_issued',
      channel_label: '#bans',
      mention_everyone: true,
      url_configured: true,
      url_mask: '…/1122…/****',
    });

    const [row] = await h.db.select().from(discordWebhooks).limit(1);
    if (!row) throw new Error('webhook row missing after create');
    const stored = Buffer.from(row.webhookUrlEncrypted as unknown as Buffer);
    expect(stored.toString('utf-8')).not.toContain(WEBHOOK_TOKEN);
    expect(decryptString(TEST_KEY, deserialize(stored))).toBe(WEBHOOK_URL);
  });

  it('GET webhooks list masks every url', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(WEBHOOK_TOKEN);
    expect(res.body).not.toContain(WEBHOOK_URL);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(item.url_mask).toBe('…/1122…/****');
      expect(JSON.stringify(item)).not.toContain(WEBHOOK_TOKEN);
    }
  });
});

describeIfDb('Discord integration — audit trail without cleartext secrets', () => {
  it('records integration.discord.update with masked before/after', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/discord',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false, bot_token: `${BOT_TOKEN}-rotated` }),
    });
    const entry = await assertAuditRow(h, {
      action: 'integration.discord.update',
      resource: 'discord_integration',
    });
    const serialized = JSON.stringify(entry.beforeSnapshot) + JSON.stringify(entry.afterSnapshot);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).toContain('bot_token_configured');
  });

  it('records webhook create + delete with masked snapshots and no token', async () => {
    const cookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ event_type: 'kick', webhook_url: WEBHOOK_URL }),
    });
    const createdId = (created.json() as { id: string }).id;

    const createEntry = await assertAuditRow(h, {
      action: 'integration.discord.webhook.create',
      resource: 'discord_webhook',
      targetId: createdId,
    });
    expect(JSON.stringify(createEntry.afterSnapshot)).not.toContain(WEBHOOK_TOKEN);
    expect(JSON.stringify(createEntry.afterSnapshot)).toContain('…/1122…/****');

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/integrations/discord/webhooks/${createdId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    const delEntry = await assertAuditRow(h, {
      action: 'integration.discord.webhook.delete',
      resource: 'discord_webhook',
      targetId: createdId,
    });
    expect(JSON.stringify(delEntry.beforeSnapshot)).not.toContain(WEBHOOK_TOKEN);
  });

  it('no audit_log row anywhere contains the cleartext webhook token', async () => {
    const rows = await h.db
      .select({ before: auditLog.beforeSnapshot, after: auditLog.afterSnapshot })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(200);
    for (const row of rows) {
      const blob = JSON.stringify(row.before) + JSON.stringify(row.after);
      expect(blob).not.toContain(WEBHOOK_TOKEN);
      expect(blob).not.toContain(BOT_TOKEN);
    }
  });
});

describeIfDb('Discord integration — validation', () => {
  it('rejects an invalid webhook url with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie: await loginAsOwner(h), 'content-type': 'application/json' },
      payload: JSON.stringify({ event_type: 'warn', webhook_url: 'https://evil.example/hook' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown event type with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie: await loginAsOwner(h), 'content-type': 'application/json' },
      payload: JSON.stringify({ event_type: 'not_real', webhook_url: WEBHOOK_URL }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates a webhook and rotates its url, keeping the mask leak-free', async () => {
    const cookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/webhooks',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ event_type: 'unban', webhook_url: WEBHOOK_URL }),
    });
    const id = (created.json() as { id: string }).id;
    const rotatedUrl = `https://discord.com/api/webhooks/998877665544332211/${WEBHOOK_TOKEN}xyz`;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/discord/webhooks/${id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ webhook_url: rotatedUrl, enabled: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(rotatedUrl);
    expect(res.json()).toMatchObject({ url_mask: '…/9988…/****', enabled: false });
  });
});

describeIfDb('Discord integration — POST /webhooks/:id/test', () => {
  async function insertWebhookRow(opts: {
    url: string;
    eventType?: string;
    mentionEveryone?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await h.db.insert(discordWebhooks).values({
      id,
      eventType: opts.eventType ?? 'ban_issued',
      webhookUrlEncrypted: serialize(encrypt(TEST_KEY, opts.url)),
      enabled: true,
      mentionEveryone: opts.mentionEveryone ?? false,
    });
    return id;
  }

  const UNKNOWN_ID = '00000000-0000-0000-0000-0000000000ff';

  it('rejects unauthenticated test-send with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/discord/webhooks/${UNKNOWN_ID}/test`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects a user without integration:manage with 403', async () => {
    const cookie = await loginAsSteam(MODERATOR_STEAM);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/discord/webhooks/${UNKNOWN_ID}/test`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns 404 webhook_not_found for an unknown webhook id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/discord/webhooks/${UNKNOWN_ID}/test`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'webhook_not_found' });
  });

  it('returns {ok:true} and writes an audit row when the fake Discord endpoint accepts the embed', async () => {
    const fake = await startFakeDiscordServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const id = await insertWebhookRow({ url: fake.url });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/integrations/discord/webhooks/${id}/test`,
        headers: { cookie: await loginAsOwner(h) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const entry = await assertAuditRow(h, {
        action: 'integration.discord.webhook.test',
        resource: 'discord_webhook',
        targetId: id,
      });
      expect(entry.afterSnapshot).toMatchObject({ outcome: 'ok', discord_status: 204 });
    } finally {
      await fake.close();
    }
  });

  it('returns 502 discord_error with the upstream status when the fake endpoint responds 500', async () => {
    const fake = await startFakeDiscordServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    try {
      const id = await insertWebhookRow({ url: fake.url, eventType: 'kick' });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/integrations/discord/webhooks/${id}/test`,
        headers: { cookie: await loginAsOwner(h) },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'discord_error', status: 500 });
      const entry = await assertAuditRow(h, {
        action: 'integration.discord.webhook.test',
        resource: 'discord_webhook',
        targetId: id,
      });
      expect(entry.afterSnapshot).toMatchObject({ outcome: 'discord_error', discord_status: 500 });
    } finally {
      await fake.close();
    }
  });

  it('returns 502 unreachable when nothing listens on the webhook host', async () => {
    const id = await insertWebhookRow({ url: 'http://127.0.0.1:1/webhook', eventType: 'warn' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/discord/webhooks/${id}/test`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'unreachable' });
  });

  it('mention_everyone webhooks include @everyone content in the test-send payload', async () => {
    let receivedBody = '';
    const fake = await startFakeDiscordServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(204);
        res.end();
      });
    });
    try {
      const id = await insertWebhookRow({ url: fake.url, mentionEveryone: true });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/integrations/discord/webhooks/${id}/test`,
        headers: { cookie: await loginAsOwner(h) },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(receivedBody) as { content?: string };
      expect(body.content).toBe('@everyone');
    } finally {
      await fake.close();
    }
  });
});
