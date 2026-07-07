import {
  DISCORD_INTEGRATION_SINGLETON_ID,
  type DiscordMessageTemplateRow,
  type DiscordWebhookRow,
  discordIntegration,
  discordMessageTemplates,
  discordWebhooks,
  isDiscordEventType,
} from '@squad/db/schema';
import {
  DISCORD_TEMPLATE_LOCALES,
  type DiscordEmbedTemplate,
  defaultDiscordTemplate,
  renderDiscordTemplate,
} from '@squad/shared-config';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { decryptString, deserialize, encrypt, serialize } from '../lib/crypto.js';
import { BOT_TOKEN_MASK, isDiscordWebhookUrl, maskWebhookUrl } from '../lib/discord.js';

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

function templateView(row: DiscordMessageTemplateRow) {
  return {
    event_type: row.eventType,
    locale: row.locale,
    template: row.template as DiscordEmbedTemplate,
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
  const url = decryptString(
    key,
    deserialize(Buffer.from(row.webhookUrlEncrypted as unknown as Buffer)),
  );
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

function auditActor(req: FastifyRequest): AuditActor {
  return req.user
    ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
    : { kind: 'system', label: 'http-anonymous' };
}

function auditContext(req: FastifyRequest): Record<string, unknown> {
  return { requestId: req.id, method: req.method, url: req.url };
}

const isForbidden = (req: FastifyRequest, reply: FastifyReply): boolean => {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return true;
  }
  return false;
};

const integrationsDiscordRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/integrations/discord',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
      const existingRows = await app.db
        .select()
        .from(discordIntegration)
        .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
        .limit(1);
      const existing = existingRows[0] ?? null;
      const before = integrationView(existing);

      const guildId =
        req.body.guild_id !== undefined ? req.body.guild_id : (existing?.guildId ?? null);
      const enabled =
        req.body.enabled !== undefined ? req.body.enabled : (existing?.enabled ?? false);
      let botTokenEncrypted: Buffer | null =
        existing?.botTokenEncrypted != null
          ? Buffer.from(existing.botTokenEncrypted as unknown as Buffer)
          : null;
      if (req.body.bot_token === null) {
        botTokenEncrypted = null;
      } else if (typeof req.body.bot_token === 'string') {
        botTokenEncrypted = serialize(encrypt(app.encryptionKey, req.body.bot_token));
      }

      const now = new Date();
      if (existing) {
        await app.db
          .update(discordIntegration)
          .set({ guildId, enabled, botTokenEncrypted, updatedAt: now })
          .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID));
      } else {
        await app.db.insert(discordIntegration).values({
          id: DISCORD_INTEGRATION_SINGLETON_ID,
          guildId,
          enabled,
          botTokenEncrypted,
          updatedAt: now,
        });
      }

      const after = integrationView({ guildId, enabled, botTokenEncrypted, updatedAt: now });
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.update',
        targetType: 'discord_integration',
        targetId: DISCORD_INTEGRATION_SINGLETON_ID,
        before,
        after,
        context: auditContext(req),
        statusCode: 200,
      });
      return after;
    },
  );

  fast.get(
    '/api/v1/integrations/discord/webhooks',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
      const id = uuidv7();
      const encryptedUrl = serialize(encrypt(app.encryptionKey, req.body.webhook_url));
      try {
        await app.db.insert(discordWebhooks).values({
          id,
          eventType: req.body.event_type,
          webhookUrlEncrypted: encryptedUrl,
          channelLabel: req.body.channel_label ?? null,
          enabled: req.body.enabled,
          mentionEveryone: req.body.mention_everyone,
          serverId: req.body.server_id ?? null,
        });
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(400);
          return { error: 'unknown_server_id' };
        }
        throw err;
      }
      const [created] = await app.db
        .select()
        .from(discordWebhooks)
        .where(eq(discordWebhooks.id, id))
        .limit(1);
      const after = created ? webhookView(created, app.encryptionKey) : null;
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.webhook.create',
        targetType: 'discord_webhook',
        targetId: id,
        after,
        context: auditContext(req),
        statusCode: 201,
      });
      reply.code(201);
      return after;
    },
  );

  fast.put(
    '/api/v1/integrations/discord/webhooks/:id',
    {
      schema: { params: idParam, body: updateWebhookBody },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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

      try {
        await app.db
          .update(discordWebhooks)
          .set(updates)
          .where(eq(discordWebhooks.id, req.params.id));
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(400);
          return { error: 'unknown_server_id' };
        }
        throw err;
      }
      const [updated] = await app.db
        .select()
        .from(discordWebhooks)
        .where(eq(discordWebhooks.id, req.params.id))
        .limit(1);
      const after = updated ? webhookView(updated, app.encryptionKey) : null;
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.webhook.update',
        targetType: 'discord_webhook',
        targetId: req.params.id,
        before,
        after,
        context: auditContext(req),
        statusCode: 200,
      });
      return after;
    },
  );

  fast.delete(
    '/api/v1/integrations/discord/webhooks/:id',
    {
      schema: { params: idParam },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      await app.db.delete(discordWebhooks).where(eq(discordWebhooks.id, req.params.id));
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.webhook.delete',
        targetType: 'discord_webhook',
        targetId: req.params.id,
        before,
        context: auditContext(req),
        statusCode: 200,
      });
      return { ok: true };
    },
  );

  fast.get(
    '/api/v1/integrations/discord/templates',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      if (isForbidden(req, reply)) return;
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
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      const now = new Date();
      await app.db
        .update(discordMessageTemplates)
        .set({
          template: req.body.template,
          locale: req.body.locale ?? existing.locale,
          isDefault: false,
          updatedAt: now,
        })
        .where(eq(discordMessageTemplates.eventType, req.params.eventType));
      const [updated] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .limit(1);
      const after = updated ? templateView(updated) : null;
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.template.update',
        targetType: 'discord_message_template',
        targetId: req.params.eventType,
        before,
        after,
        context: auditContext(req),
        statusCode: 200,
      });
      return after;
    },
  );

  fast.post(
    '/api/v1/integrations/discord/templates/:eventType/reset',
    {
      schema: { params: eventTypeParam },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
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
      const now = new Date();
      await app.db
        .update(discordMessageTemplates)
        .set({
          template: fallback.template,
          locale: fallback.locale,
          isDefault: true,
          updatedAt: now,
        })
        .where(eq(discordMessageTemplates.eventType, req.params.eventType));
      const [updated] = await app.db
        .select()
        .from(discordMessageTemplates)
        .where(eq(discordMessageTemplates.eventType, req.params.eventType))
        .limit(1);
      const after = updated ? templateView(updated) : null;
      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'integration.discord.template.reset',
        targetType: 'discord_message_template',
        targetId: req.params.eventType,
        before,
        after,
        context: auditContext(req),
        statusCode: 200,
      });
      return after;
    },
  );

  fast.post(
    '/api/v1/integrations/discord/templates/:eventType/preview',
    {
      schema: { params: eventTypeParam, body: previewBody },
      config: { permissions: [INTEGRATION_PERMISSION], audit: false },
    },
    async (req, reply) => {
      if (isForbidden(req, reply)) return;
      const missing: string[] = [];
      const embed = renderDiscordTemplate(req.body.template, req.body.context, {
        onMissingPlaceholder: (placeholder) => {
          if (!missing.includes(placeholder)) missing.push(placeholder);
        },
      });
      return { event_type: req.params.eventType, embed, missing_placeholders: missing };
    },
  );
};

function isForeignKeyViolation(err: unknown): boolean {
  return (
    (err as { code?: string }).code === '23503' ||
    (err as { cause?: { code?: string } }).cause?.code === '23503'
  );
}

export default integrationsDiscordRoutes;
