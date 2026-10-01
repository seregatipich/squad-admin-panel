import { discordMessageTemplates } from '@squad/db/schema';
import {
  DISCORD_TEMPLATE_LOCALES,
  defaultDiscordTemplate,
  renderDiscordTemplate,
} from '@squad/shared-config';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eventTypeSchema, INTEGRATION_PERMISSION } from '../../lib/integrations-discord/common.js';
import { embedTemplateSchema, templateView } from '../../lib/integrations-discord/templates.js';

const eventTypeParam = z.object({ eventType: eventTypeSchema });

const putTemplateBody = z.object({
  template: embedTemplateSchema,
  locale: z.enum(DISCORD_TEMPLATE_LOCALES).optional(),
});

const previewBody = z.object({
  template: embedTemplateSchema,
  context: z.record(z.string(), z.string()).default({}),
});

/** Discord message templates: list, read, edit, reset and preview. */
const discordTemplateRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

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
};

export default discordTemplateRoutes;
