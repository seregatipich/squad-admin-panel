import {
  DISCORD_INTEGRATION_SINGLETON_ID,
  type DiscordMessageTemplateRow,
  type DiscordWebhookRow,
  discordIntegration,
  discordMessageTemplates,
  discordWebhooks,
  isDiscordEventType,
  servers,
} from '@squad/db/schema';
import {
  DISCORD_TEMPLATE_LOCALES,
  type DiscordEmbedTemplate,
  defaultDiscordTemplate,
  renderDiscordTemplate,
} from '@squad/shared-config';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { BOT_TOKEN_MASK, isDiscordWebhookUrl, maskWebhookUrl } from '../lib/discord.js';
import { hasPgErrorCode, PG_FOREIGN_KEY_VIOLATION } from '../lib/pg-errors.js';

const INTEGRATION_PERMISSION = 'integration:manage' as const;

const guildIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,32}$/, 'invalid guild id');
const channelLabelSchema = z.string().trim().max(100);
const eventTypeSchema = z.string().refine(isDiscordEventType, { message: 'unknown event type' });
const webhookUrlSchema = z
  .string()
  .trim()
  .refine(isDiscordWebhookUrl, { message: 'invalid discord webhook url' });

const putIntegrationBody = z.object({
  guild_id: guildIdSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  bot_token: z.string().trim().min(1).max(120).nullable().optional(),
});

const createWebhookBody = z.object({
  event_type: eventTypeSchema,
  webhook_url: webhookUrlSchema,
  channel_label: channelLabelSchema.nullable().optional(),
  enabled: z.boolean().default(true),
  mention_everyone: z.boolean().default(false),
  server_id: z.string().uuid().nullable().optional(),
});

const updateWebhookBody = z.object({
  event_type: eventTypeSchema.optional(),
  webhook_url: webhookUrlSchema.optional(),
  channel_label: channelLabelSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  mention_everyone: z.boolean().optional(),
  server_id: z.string().uuid().nullable().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const eventTypeParam = z.object({ eventType: eventTypeSchema });

const embedFieldSchema = z.object({
  name: z.string().max(256),
  value: z.string().max(1024),
  inline: z.boolean(),
});

const embedTemplateSchema = z.object({
  title: z.string().max(256),
  url: z.string().trim().max(2048).nullable().optional(),
  description: z.string().max(4096),
  color: z.number().int().min(0).max(0xffffff),
  fields: z.array(embedFieldSchema).max(25),
});

const putTemplateBody = z.object({
  template: embedTemplateSchema,
  locale: z.enum(DISCORD_TEMPLATE_LOCALES).optional(),
});

const previewBody = z.object({
  template: embedTemplateSchema,
  context: z.record(z.string(), z.string()).default({}),
});

/** Cyrillic-safe placeholder values for POST /webhooks/:id/test — exercises markdown escaping the same way real player names would. */
const TEST_SEND_SAMPLE_CONTEXT: Record<string, string> = {
  player_name: 'Тестовый Игрок',
  player_id: '00000000-0000-0000-0000-000000000000',
  player_url: '#',
  steam_id64: '76561198000000000',
  eos_id: '00000000000000000000000000000000',
  server_name: 'Тестовый сервер',
  reason: 'Тестовая причина',
  duration: 'постоянно',
  actor_name: 'Администратор',
  map: 'Narva_RAAS_v1',
};

const TEST_SEND_TIMEOUT_MS = 5_000;

/**
 * The stored jsonb template, validated against the same schema the PUT route
 * enforces. A row that no longer fits (hand-edited, or written by an older
 * migration) falls back to the code default for its event type instead of
 * reaching `renderDiscordTemplate` as an arbitrary object; `null` when there
 * is no default either.
 */
function storedTemplate(row: DiscordMessageTemplateRow): DiscordEmbedTemplate | null {
  const parsed = embedTemplateSchema.safeParse(row.template);
  if (parsed.success) return parsed.data;
  return defaultDiscordTemplate(row.eventType)?.template ?? null;
}

function templateView(row: DiscordMessageTemplateRow) {
  return {
    event_type: row.eventType,
    locale: row.locale,
    template: storedTemplate(row),
    is_default: row.isDefault,
    updated_at: row.updatedAt.toISOString(),
  };
}

interface IntegrationRowLike {
  guildId: string | null;
  botTokenEncrypted: Buffer | null;
  enabled: boolean;
  updatedAt: Date;
}

function integrationView(row: IntegrationRowLike | null) {
  if (!row) {
    return {
      guild_id: null,
      enabled: false,
      bot_token_configured: false,
      bot_token_mask: null,
      updated_at: null,
    };
  }
  const configured = row.botTokenEncrypted != null;
  return {
    guild_id: row.guildId,
    enabled: row.enabled,
    bot_token_configured: configured,
    bot_token_mask: configured ? BOT_TOKEN_MASK : null,
    updated_at: row.updatedAt.toISOString(),
  };
}

function webhookView(row: DiscordWebhookRow, key: Buffer) {
  const url = decryptString(key, deserialize(row.webhookUrlEncrypted));
  return {
    id: row.id,
    event_type: row.eventType,
    channel_label: row.channelLabel,
    enabled: row.enabled,
    mention_everyone: row.mentionEveryone,
    server_id: row.serverId,
    url_configured: true,
    url_mask: maskWebhookUrl(url),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Discord integration settings, webhooks, templates and status channels.
 *
 * Authentication is the global `plugins/auth.ts` hook (401 for any non-public
 * route without a session) and authorization is `config.permissions`, so the
 * handlers never re-check `req.user`. Every mutating route declares
 * `config.audit` and fills `req.auditSnapshots`, so `plugins/audit.ts` records
 * each attempt — including 401/403 refusals and 400/404 failures — with masked
 * before/after snapshots (no cleartext bot token or webhook URL).
 */
const integrationsDiscordRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/integrations/discord',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select()
        .from(discordIntegration)
        .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
        .limit(1);
      return integrationView(rows[0] ?? null);
    },
  );

  fast.put(
    '/api/v1/integrations/discord',
    {
      schema: { body: putIntegrationBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.update', resource: 'discord_integration' },
      },
    },
    async (req) => {
      const botToken = req.body.bot_token;
      const encryptedToken =
        typeof botToken === 'string' ? serialize(encrypt(app.encryptionKey, botToken)) : null;

      // Read-modify-write of the singleton under a row lock: the idempotent
      // insert makes the row exist (and waits for a concurrent creator), then
      // FOR UPDATE serialises concurrent PUTs so neither 500s on the primary
      // key nor overwrites the other's fields from a stale read.
      const { created, existing, updated } = await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(discordIntegration)
          .values({ id: DISCORD_INTEGRATION_SINGLETON_ID })
          .onConflictDoNothing()
          .returning({ id: discordIntegration.id });
        const [current] = await tx
          .select()
          .from(discordIntegration)
          .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
          .for('update');
        if (!current) throw new Error('discord_integration singleton missing after upsert');

        const [row] = await tx
          .update(discordIntegration)
          .set({
            guildId: req.body.guild_id !== undefined ? req.body.guild_id : current.guildId,
            enabled: req.body.enabled ?? current.enabled,
            botTokenEncrypted: botToken === undefined ? current.botTokenEncrypted : encryptedToken,
            updatedAt: new Date(),
          })
          .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
          .returning();
        if (!row) throw new Error('discord_integration singleton update returned no row');
        return { created: inserted.length > 0, existing: current, updated: row };
      });

      const after = integrationView(updated);
      req.auditSnapshots = {
        before: integrationView(created ? null : existing),
        after,
        targetId: DISCORD_INTEGRATION_SINGLETON_ID,
      };
      return after;
    },
  );

  fast.get(
    '/api/v1/integrations/discord/webhooks',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select()
        .from(discordWebhooks)
        .orderBy(asc(discordWebhooks.createdAt));
      return rows.map((row) => webhookView(row, app.encryptionKey));
    },
  );

  fast.post(
    '/api/v1/integrations/discord/webhooks',
    {
      schema: { body: createWebhookBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.webhook.create', resource: 'discord_webhook' },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      req.auditSnapshots = { targetId: id };
      const encryptedUrl = serialize(encrypt(app.encryptionKey, req.body.webhook_url));
      let created: DiscordWebhookRow | undefined;
      try {
        [created] = await app.db
          .insert(discordWebhooks)
          .values({
            id,
            eventType: req.body.event_type,
            webhookUrlEncrypted: encryptedUrl,
            channelLabel: req.body.channel_label ?? null,
            enabled: req.body.enabled,
            mentionEveryone: req.body.mention_everyone,
            serverId: req.body.server_id ?? null,
          })
          .returning();
      } catch (err) {
        if (hasPgErrorCode(err, PG_FOREIGN_KEY_VIOLATION)) {
          reply.code(400);
          return { error: 'unknown_server_id' };
        }
        throw err;
      }
      if (!created) throw new Error('discord_webhooks insert returned no row');
      const after = webhookView(created, app.encryptionKey);
      req.auditSnapshots = { after, targetId: id };
      reply.code(201);
      return after;
    },
  );

  fast.put(
    '/api/v1/integrations/discord/webhooks/:id',
    {
      schema: { params: idParam, body: updateWebhookBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.webhook.update', resource: 'discord_webhook' },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(discordWebhooks)
        .where(eq(discordWebhooks.id, req.params.id))
        .limit(1);
      if (!existing) {
        reply.code(404);
        return { error: 'webhook_not_found' };
      }
      const before = webhookView(existing, app.encryptionKey);
      req.auditSnapshots = { before };

      const updates: Partial<typeof discordWebhooks.$inferInsert> = { updatedAt: new Date() };
      if (req.body.event_type !== undefined) updates.eventType = req.body.event_type;
      if (req.body.webhook_url !== undefined) {
        updates.webhookUrlEncrypted = serialize(encrypt(app.encryptionKey, req.body.webhook_url));
      }
      if (req.body.channel_label !== undefined) updates.channelLabel = req.body.channel_label;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.mention_everyone !== undefined)
        updates.mentionEveryone = req.body.mention_everyone;
      if (req.body.server_id !== undefined) updates.serverId = req.body.server_id;

      let updated: DiscordWebhookRow | undefined;
      try {
        [updated] = await app.db
          .update(discordWebhooks)
          .set(updates)
          .where(eq(discordWebhooks.id, req.params.id))
          .returning();
      } catch (err) {
        if (hasPgErrorCode(err, PG_FOREIGN_KEY_VIOLATION)) {
          reply.code(400);
          return { error: 'unknown_server_id' };
        }
        throw err;
      }
      if (!updated) {
        reply.code(404);
        return { error: 'webhook_not_found' };
      }
      const after = webhookView(updated, app.encryptionKey);
      req.auditSnapshots = { before, after };
      return after;
    },
  );

  fast.delete(
    '/api/v1/integrations/discord/webhooks/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.webhook.delete', resource: 'discord_webhook' },
      },
    },
    async (req, reply) => {
      const [deleted] = await app.db
        .delete(discordWebhooks)
        .where(eq(discordWebhooks.id, req.params.id))
        .returning();
      if (!deleted) {
        reply.code(404);
        return { error: 'webhook_not_found' };
      }
      req.auditSnapshots = { before: webhookView(deleted, app.encryptionKey) };
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/integrations/discord/webhooks/:id/test',
    {
      schema: { params: idParam },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.webhook.test', resource: 'discord_webhook' },
      },
    },
    async (req, reply) => {
      const [webhook] = await app.db
        .select()
        .from(discordWebhooks)
        .where(eq(discordWebhooks.id, req.params.id))
        .limit(1);
      if (!webhook) {
        reply.code(404);
        return { error: 'webhook_not_found' };
      }

      const [templateRow] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, webhook.eventType))
        .limit(1);
      const template = templateRow
        ? storedTemplate(templateRow)
        : defaultDiscordTemplate(webhook.eventType)?.template;
      if (!template) {
        reply.code(404);
        return { error: 'template_not_found' };
      }

      const embed = renderDiscordTemplate(template, TEST_SEND_SAMPLE_CONTEXT);
      const payload: Record<string, unknown> = { embeds: [embed] };
      if (webhook.mentionEveryone) {
        payload.content = '@everyone';
        payload.allowed_mentions = { parse: ['everyone'] };
      }

      const url = decryptString(app.encryptionKey, deserialize(webhook.webhookUrlEncrypted));

      let outcome: 'ok' | 'discord_error' | 'unreachable';
      let discordStatus: number | null = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TEST_SEND_TIMEOUT_MS),
        });
        discordStatus = res.status;
        outcome = res.ok ? 'ok' : 'discord_error';
        // Only the status matters; release the body so undici frees the
        // socket now instead of whenever the response is garbage-collected.
        await res.body?.cancel().catch(() => undefined);
      } catch {
        // Network error, DNS failure, connection refused, or the AbortSignal
        // timeout firing — all surface identically to the operator as
        // "webhook unreachable"; the exact cause is not actionable from the UI.
        outcome = 'unreachable';
      }

      req.auditSnapshots = { after: { outcome, discord_status: discordStatus } };

      if (outcome === 'unreachable') {
        reply.code(502);
        return { error: 'unreachable' };
      }
      if (outcome === 'discord_error') {
        reply.code(502);
        return { error: 'discord_error', status: discordStatus };
      }
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/integrations/discord/templates',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select()
        .from(discordMessageTemplates)
        .orderBy(asc(discordMessageTemplates.eventType));
      return rows.map(templateView);
    },
  );

  fast.get(
    '/api/v1/integrations/discord/templates/:eventType',
    {
      schema: { params: eventTypeParam },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .limit(1);
      if (!row) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      return templateView(row);
    },
  );

  fast.put(
    '/api/v1/integrations/discord/templates/:eventType',
    {
      schema: { params: eventTypeParam, body: putTemplateBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: {
          action: 'integration.discord.template.update',
          resource: 'discord_message_template',
        },
      },
    },
    async (req, reply) => {
      req.auditSnapshots = { targetId: req.params.eventType };
      const [existing] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .limit(1);
      if (!existing) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      const before = templateView(existing);
      const [updated] = await app.db
        .update(discordMessageTemplates)
        .set({
          template: req.body.template,
          locale: req.body.locale ?? existing.locale,
          isDefault: false,
          updatedAt: new Date(),
        })
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .returning();
      if (!updated) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      const after = templateView(updated);
      req.auditSnapshots = { before, after, targetId: req.params.eventType };
      return after;
    },
  );

  fast.post(
    '/api/v1/integrations/discord/templates/:eventType/reset',
    {
      schema: { params: eventTypeParam },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: {
          action: 'integration.discord.template.reset',
          resource: 'discord_message_template',
        },
      },
    },
    async (req, reply) => {
      req.auditSnapshots = { targetId: req.params.eventType };
      const fallback = defaultDiscordTemplate(req.params.eventType);
      if (!fallback) {
        reply.code(404);
        return { error: 'template_not_found' };
      }
      const [existing] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .limit(1);
      const before = existing ? templateView(existing) : null;
      const [updated] = await app.db
        .update(discordMessageTemplates)
        .set({
          template: fallback.template,
          locale: fallback.locale,
          isDefault: true,
          updatedAt: new Date(),
        })
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .returning();
      const after = updated ? templateView(updated) : null;
      req.auditSnapshots = { before, after, targetId: req.params.eventType };
      return after;
    },
  );

  fast.post(
    '/api/v1/integrations/discord/templates/:eventType/preview',
    {
      schema: { params: eventTypeParam, body: previewBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: {
          action: 'integration.discord.template.preview',
          resource: 'discord_message_template',
        },
      },
    },
    async (req) => {
      const missing: string[] = [];
      const embed = renderDiscordTemplate(req.body.template, req.body.context, {
        onMissingPlaceholder: (placeholder) => {
          if (!missing.includes(placeholder)) missing.push(placeholder);
        },
      });
      return { event_type: req.params.eventType, embed, missing_placeholders: missing };
    },
  );

  // DISCORD-6 (#153): one status channel per server. The worker renames that
  // channel to the live server state, so the panel stores only which channel to
  // rename; NULL means "not configured" and the worker skips that server.
  fast.get(
    '/api/v1/integrations/discord/status-channels',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select({
          serverId: servers.id,
          displayName: servers.displayName,
          slug: servers.slug,
          statusChannelId: servers.statusChannelId,
        })
        .from(servers)
        .where(isNull(servers.deletedAt))
        .orderBy(asc(servers.displayName));
      return {
        items: rows.map((r) => ({
          server_id: r.serverId,
          display_name: r.displayName,
          slug: r.slug,
          channel_id: r.statusChannelId,
        })),
      };
    },
  );

  fast.put(
    '/api/v1/integrations/discord/servers/:serverId/status-channel',
    {
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        // A Discord snowflake is a 64-bit unsigned id, so it travels as digits-only text.
        body: z.object({
          channel_id: z
            .string()
            .trim()
            .regex(/^\d{1,32}$/)
            .nullable(),
        }),
      },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.status_channel.set', resource: 'server' },
      },
    },
    async (req, reply) => {
      const [before] = await app.db
        .select({ id: servers.id, statusChannelId: servers.statusChannelId })
        .from(servers)
        .where(and(eq(servers.id, req.params.serverId), isNull(servers.deletedAt)))
        .limit(1);
      if (!before) {
        reply.code(404);
        return { error: 'server_not_found' };
      }
      await app.db
        .update(servers)
        .set({ statusChannelId: req.body.channel_id })
        .where(eq(servers.id, req.params.serverId));
      req.auditSnapshots = {
        before: { channel_id: before.statusChannelId },
        after: { channel_id: req.body.channel_id },
      };
      return { ok: true, channel_id: req.body.channel_id };
    },
  );
};

export default integrationsDiscordRoutes;
