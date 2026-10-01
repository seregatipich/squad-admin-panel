import { type DiscordWebhookRow, discordMessageTemplates, discordWebhooks } from '@squad/db/schema';
import { defaultDiscordTemplate, renderDiscordTemplate } from '@squad/shared-config';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { decryptString, deserialize, encrypt, serialize } from '../../lib/crypto.js';
import { isDiscordWebhookUrl, maskWebhookUrl } from '../../lib/discord.js';
import { eventTypeSchema, INTEGRATION_PERMISSION } from '../../lib/integrations-discord/common.js';
import { storedTemplate } from '../../lib/integrations-discord/templates.js';
import { hasPgErrorCode, PG_FOREIGN_KEY_VIOLATION } from '../../lib/pg-errors.js';

const channelLabelSchema = z.string().trim().max(100);

const webhookUrlSchema = z
  .string()
  .trim()
  .refine(isDiscordWebhookUrl, { message: 'invalid discord webhook url' });

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
 * Decrypts a stored webhook URL.
 *
 * @returns The URL, or null when the ciphertext cannot be decrypted with
 *   `key` (the row was written under a rotated `APP_ENCRYPTION_KEY`, or is
 *   corrupt) — AES-GCM rejects it on the auth-tag check.
 */
function decryptWebhookUrl(row: DiscordWebhookRow, key: Buffer): string | null {
  try {
    return decryptString(key, deserialize(row.webhookUrlEncrypted));
  } catch {
    return null;
  }
}

/**
 * API view of a webhook row. An undecryptable URL is reported as not
 * configured instead of failing, so one such row cannot break the list or
 * block its own deletion.
 */
function webhookView(row: DiscordWebhookRow, key: Buffer) {
  const url = decryptWebhookUrl(row, key);
  return {
    id: row.id,
    event_type: row.eventType,
    channel_label: row.channelLabel,
    enabled: row.enabled,
    mention_everyone: row.mentionEveryone,
    server_id: row.serverId,
    url_configured: url !== null,
    url_mask: url === null ? null : maskWebhookUrl(url),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Discord webhooks: list, create, update, delete and test send. */
const discordWebhookRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

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

      const url = decryptWebhookUrl(webhook, app.encryptionKey);
      if (url === null) {
        reply.code(409);
        return { error: 'webhook_url_unreadable' };
      }

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
};

export default discordWebhookRoutes;
