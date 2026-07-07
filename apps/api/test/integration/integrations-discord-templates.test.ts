import { discordMessageTemplates, players, roles } from '@squad/db/schema';
import {
  DEFAULT_DISCORD_TEMPLATES,
  type DiscordEmbedTemplate,
  renderDiscordTemplate,
} from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(920001);
const MODERATOR_STEAM = testSteamId(920002);

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
    userAgent: 'discord-templates-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

/** Read the stored template exactly as the worker would before rendering. */
async function storedTemplate(eventType: string): Promise<DiscordEmbedTemplate> {
  const [row] = await h.db
    .select()
    .from(discordMessageTemplates)
    .where(eq(discordMessageTemplates.eventType, eventType))
    .limit(1);
  if (!row) throw new Error(`no template for ${eventType}`);
  return row.template as DiscordEmbedTemplate;
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

  await h.db
    .insert(players)
    .values({
      steamId64: MODERATOR_STEAM,
      canonicalName: 'ModTpl',
      canonicalNameNormalized: 'modtpl',
      roleId: moderatorRole.id,
    })
    .onConflictDoNothing();
  invalidateAllPermissionCaches();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('Discord templates — RBAC gating', () => {
  const endpoints: Array<{ method: 'GET' | 'PUT' | 'POST'; url: string }> = [
    { method: 'GET', url: '/api/v1/integrations/discord/templates' },
    { method: 'GET', url: '/api/v1/integrations/discord/templates/ban_issued' },
    { method: 'PUT', url: '/api/v1/integrations/discord/templates/ban_issued' },
    { method: 'POST', url: '/api/v1/integrations/discord/templates/ban_issued/reset' },
    { method: 'POST', url: '/api/v1/integrations/discord/templates/ban_issued/preview' },
  ];

  it('rejects unauthenticated requests with 401', async () => {
    for (const ep of endpoints) {
      const res = await h.app.inject({ method: ep.method, url: ep.url, payload: '{}' });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it('rejects users without integration:manage with 403', async () => {
    const cookie = await loginAsSteam(MODERATOR_STEAM);
    for (const ep of endpoints) {
      const res = await h.app.inject({
        method: ep.method,
        url: ep.url,
        headers: { cookie, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
    }
  });
});

describeIfDb('Discord templates — seed', () => {
  it('seeds exactly one template per event type matching the code defaults', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/templates',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{
      event_type: string;
      template: DiscordEmbedTemplate;
      is_default: boolean;
    }>;
    expect(rows).toHaveLength(DEFAULT_DISCORD_TEMPLATES.length);
    for (const def of DEFAULT_DISCORD_TEMPLATES) {
      const row = rows.find((r) => r.event_type === def.eventType);
      expect(row, def.eventType).toBeDefined();
      expect(row?.is_default).toBe(true);
      expect(row?.template).toEqual(def.template);
    }
  });
});

describeIfDb('Discord templates — edit, render, reset', () => {
  const edited: DiscordEmbedTemplate = {
    title: 'CUSTOM BAN',
    url: '{player_url}',
    description: '{player_name} banned by {actor_name}: {reason}',
    color: 0x112233,
    fields: [{ name: 'Player', value: '{player_name}', inline: true }],
  };

  const context = {
    player_name: 'Griefer',
    player_url: 'https://panel.example/players/uuid-1',
    actor_name: 'AdminJane',
    reason: 'teamkilling',
    server_name: 'Main #1',
  };

  it('persists an edited template and writes an audit entry', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/discord/templates/ban_issued',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ template: edited, locale: 'en' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ event_type: 'ban_issued', is_default: false });

    const stored = await storedTemplate('ban_issued');
    expect(stored).toEqual(edited);
    await assertAuditRow(h, {
      action: 'integration.discord.template.update',
      resource: 'discord_message_template',
      targetId: 'ban_issued',
    });
  });

  it('renders the freshly-stored template — a worker picks up edits without a restart', async () => {
    const stored = await storedTemplate('ban_issued');
    const embed = renderDiscordTemplate(stored, context);
    expect(embed.title).toBe('CUSTOM BAN');
    expect(embed.description).toBe('Griefer banned by AdminJane: teamkilling');
    expect(embed.url).toBe('https://panel.example/players/uuid-1');
  });

  it('preview matches the embed rendered from the stored template', async () => {
    const cookie = await loginAsOwner(h);
    const stored = await storedTemplate('ban_issued');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/templates/ban_issued/preview',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ template: stored, context }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { embed: DiscordEmbedTemplate; missing_placeholders: string[] };
    expect(body.embed).toEqual(renderDiscordTemplate(stored, context));
    expect(body.missing_placeholders).toEqual([]);
  });

  it('does not crash on an unknown placeholder — it renders empty and is reported', async () => {
    const cookie = await loginAsOwner(h);
    const bogus: DiscordEmbedTemplate = {
      title: 'Bad {not_a_placeholder}',
      url: null,
      description: 'ok {player_name}',
      color: 0,
      fields: [],
    };
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/templates/ban_issued/preview',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ template: bogus, context: { player_name: 'Bob' } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { embed: DiscordEmbedTemplate; missing_placeholders: string[] };
    expect(body.embed.title).toBe('Bad ');
    expect(body.embed.description).toBe('ok Bob');
    expect(body.missing_placeholders).toEqual(['not_a_placeholder']);
  });

  it('resets an edited template back to the default and records it', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/discord/templates/ban_issued/reset',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ event_type: 'ban_issued', is_default: true });

    const stored = await storedTemplate('ban_issued');
    const def = DEFAULT_DISCORD_TEMPLATES.find((t) => t.eventType === 'ban_issued');
    expect(stored).toEqual(def?.template);
    await assertAuditRow(h, {
      action: 'integration.discord.template.reset',
      resource: 'discord_message_template',
      targetId: 'ban_issued',
    });
  });

  it('rejects an unknown event type with a 400 validation error', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/discord/templates/not_a_real_event',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
