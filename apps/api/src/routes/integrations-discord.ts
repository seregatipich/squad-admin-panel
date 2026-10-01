import type { FastifyPluginAsync } from 'fastify';

import discordSettingsRoutes from './integrations-discord/settings.js';
import discordStatusChannelRoutes from './integrations-discord/status-channels.js';
import discordTemplateRoutes from './integrations-discord/templates.js';
import discordWebhookRoutes from './integrations-discord/webhooks.js';

/**
 * Discord integration settings, webhooks, templates and status channels, one
 * sub-plugin per concern.
 *
 * Authentication is the global `plugins/auth.ts` hook (401 for any non-public
 * route without a session) and authorization is `config.permissions`, so the
 * handlers never re-check `req.user`. Every mutating route declares
 * `config.audit` and fills `req.auditSnapshots`, so `plugins/audit.ts` records
 * each attempt — including 401/403 refusals and 400/404 failures — with masked
 * before/after snapshots (no cleartext bot token or webhook URL).
 */
const integrationsDiscordRoutes: FastifyPluginAsync = async (app) => {
  await app.register(discordSettingsRoutes);
  await app.register(discordWebhookRoutes);
  await app.register(discordTemplateRoutes);
  await app.register(discordStatusChannelRoutes);
};

export default integrationsDiscordRoutes;
