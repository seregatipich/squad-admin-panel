import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { redisSinkStream } from '@squad/shared-config';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import { loadEncryptionKey } from './lib/crypto.js';
import diagPlugin from './lib/diag.js';
import { buildLogger } from './lib/logger.js';
import { MEDIA_MAX_UPLOAD_BYTES } from './lib/media-storage.js';
import { createRconClient } from './lib/rcon.js';
import auditPlugin from './plugins/audit.js';
import authPlugin from './plugins/auth.js';
import bridgePlugin from './plugins/bridge.js';
import bridgeHeartbeatPlugin from './plugins/bridge-heartbeat.js';
import databasePlugin from './plugins/database.js';
import dbHealthPlugin from './plugins/db-health.js';
import errorDiagPlugin from './plugins/error-diag.js';
import healthPlugin from './plugins/health.js';
import heartbeatWatchPlugin from './plugins/heartbeat-watch.js';
import installProgressPlugin from './plugins/install-progress.js';
import liveBusPlugin from './plugins/live-bus.js';
import metricsPlugin from './plugins/metrics.js';
import orphanSweepPlugin from './plugins/orphan-sweep.js';
import redisPlugin from './plugins/redis.js';
import requestContextPlugin from './plugins/request-context.js';
import statusReconcilerPlugin from './plugins/status-reconciler.js';
import adminsCfgRoutes from './routes/admins-cfg.js';
import alertRulesRoutes from './routes/alert-rules.js';
import analyticsRoutes from './routes/analytics.js';
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import steamRoutes from './routes/auth-steam.js';
import automationRulesRoutes from './routes/automation-rules.js';
import banSourcesRoutes from './routes/ban-sources.js';
import bannedNamesRoutes from './routes/banned-names.js';
import chatRoutes from './routes/chat.js';
import clansRoutes from './routes/clans.js';
import combatEventsRoutes from './routes/combat-events.js';
import depotRoutes from './routes/depot.js';
import economyRoutes from './routes/economy.js';
import eventsRoutes from './routes/events.js';
import externalBansRoutes from './routes/external-bans.js';
import hostRoutes from './routes/host.js';
import hostActionsRoutes from './routes/host-actions.js';
import hostBackupRoutes from './routes/host-backup.js';
import integrationsDiscordRoutes from './routes/integrations-discord.js';
import integrationsGeoipRoutes from './routes/integrations-geoip.js';
import integrationsVipRoutes from './routes/integrations-vip.js';
import issuesRoutes from './routes/issues.js';
import layersRoutes from './routes/layers.js';
import leaderboardsRoutes from './routes/leaderboards.js';
import leaderboardsBonusesRoutes from './routes/leaderboards-bonuses.js';
import liveRoutes from './routes/live.js';
import logsRoutes from './routes/logs.js';
import markTypesRoutes from './routes/mark-types.js';
import marksRoutes from './routes/marks.js';
import matchesRoutes from './routes/matches.js';
import meTokensRoutes from './routes/me-tokens.js';
import mediaRoutes from './routes/media.js';
import mediaLinksRoutes from './routes/media-links.js';
import messageTemplatesRoutes from './routes/message-templates.js';
import moderationActionsRoutes from './routes/moderation-actions.js';
import moderationBulkRoutes from './routes/moderation-bulk.js';
import notesFeedRoutes from './routes/notes-feed.js';
import permissionsRoutes from './routes/permissions.js';
import playerAltCandidatesRoutes from './routes/player-alt-candidates.js';
import playerBanAltWarningRoutes from './routes/player-ban-alt-warning.js';
import playerCombatTrendRoutes from './routes/player-combat-trend.js';
import playerCompareOnlineRoutes from './routes/player-compare-online.js';
import playerCoplayRoutes from './routes/player-coplay.js';
import playerDossierRoutes from './routes/player-dossier.js';
import playerDossierStatsRoutes from './routes/player-dossier-stats.js';
import playerGeoAnomaliesRoutes from './routes/player-geo-anomalies.js';
import playerLinksRoutes from './routes/player-links.js';
import playerMatchesRoutes from './routes/player-matches.js';
import playerNotesRoutes from './routes/player-notes.js';
import playerPresenceRoutes from './routes/player-presence.js';
import playerSeedContributionRoutes from './routes/player-seed-contribution.js';
import playerSteamFriendCheckRoutes from './routes/player-steam-friend-check.js';
import playerRoutes from './routes/players.js';
import publicBanlistRoutes from './routes/public-banlist.js';
import publicClansRoutes from './routes/public-clans.js';
import publicStatsRoutes from './routes/public-stats.js';
import reportActionsRoutes from './routes/report-actions.js';
import reportAnalyticsRoutes from './routes/report-analytics.js';
import reportsRoutes from './routes/reports.js';
import roleAssignmentsRoutes from './routes/role-assignments.js';
import roleMembersRoutes from './routes/role-members.js';
import rolesRoutes from './routes/roles.js';
import archiveRoutes from './routes/server-archive.js';
import serverChatCommandsRoutes from './routes/server-chat-commands.js';
import serverConfigRoutes from './routes/server-configs.js';
import forceStopRoutes from './routes/server-force-stop.js';
import serverInstallRoutes from './routes/server-install.js';
import serverLogFilesRoutes from './routes/server-log-files.js';
import serverLogsRoutes from './routes/server-logs.js';
import serverMapRoutes from './routes/server-map.js';
import serverMapVoteRoutes from './routes/server-map-vote.js';
import serverMessagingRoutes from './routes/server-messaging.js';
import serverMetricsRoutes from './routes/server-metrics.js';
import serverRnsquadjsRoutes from './routes/server-rnsquadjs.js';
import serverRosterRoutes from './routes/server-roster.js';
import serverRotationRoutes from './routes/server-rotation.js';
import serverRotationCalendarRoutes from './routes/server-rotation-calendar.js';
import serverScheduledTasksRoutes from './routes/server-scheduled-tasks.js';
import serverSeedNotificationRoutes from './routes/server-seed-notifications.js';
import serverSeedScheduleRoutes from './routes/server-seed-schedule.js';
import serverSeedingRoutes from './routes/server-seeding.js';
import serverSettingsRoutes from './routes/server-settings.js';
import serverUpdateRoutes from './routes/server-update.js';
import serverRoutes from './routes/servers.js';
import settingsAltDetectionRoutes from './routes/settings-alt-detection.js';
import settingsBanlistPublicationRoutes from './routes/settings-banlist-publication.js';
import settingsChatFlagsRoutes from './routes/settings-chat-flags.js';
import settingsClanGuardRoutes from './routes/settings-clan-guard.js';
import settingsCoplayRoutes from './routes/settings-coplay.js';
import settingsEconomyRoutes from './routes/settings-economy.js';
import setupRoutes from './routes/setup.js';
import suspectsRoutes from './routes/suspects.js';
import teamkillsRoutes from './routes/teamkills.js';
import usersRoutes from './routes/users.js';
import vehicleCatalogRoutes from './routes/vehicle-catalog.js';
import vipTiersRoutes from './routes/vip-tiers.js';
import voteAnalyticsRoutes from './routes/vote-analytics.js';
import votesRoutes from './routes/votes.js';
import whitelistRoutes from './routes/whitelist.js';
import whitelistApplicationsRoutes from './routes/whitelist-applications.js';

// Side-effect import: augments the Fastify types with our plugin context.
import './plugins/types.js';

export async function buildServer(config: AppConfig) {
  const { logger, lateSink } = buildLogger(config.LOG_LEVEL);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    disableRequestLogging: false,
    genReqId: (req) =>
      (req.headers['x-request-id'] as string | undefined) ??
      `req-${Math.random().toString(36).slice(2)}`,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('encryptionKey', loadEncryptionKey(config.APP_ENCRYPTION_KEY));
  app.decorate('config', config);
  app.decorate('rcon', createRconClient());

  await app.register(helmet, { global: true });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, {
    max: 1200,
    timeWindow: '1 minute',
    keyGenerator: (req) => `${req.ip}:${req.user?.playerId ?? ''}`,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Squad Admin Panel API', version: '0.1.0-p0' },
      components: {
        securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-sid' } },
      },
      security: [{ cookieAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1 } });

  await app.register(requestContextPlugin);
  await app.register(databasePlugin, { config });
  await app.register(redisPlugin, { config });
  lateSink.setInner(redisSinkStream({ redis: app.redis, defaultSource: 'api' }));
  await app.register(diagPlugin);
  await app.register(errorDiagPlugin);
  await app.register(dbHealthPlugin);
  await app.register(heartbeatWatchPlugin);
  await app.register(liveBusPlugin);
  await app.register(bridgePlugin, { config });
  await app.register(bridgeHeartbeatPlugin);
  await app.register(metricsPlugin);
  await app.register(healthPlugin);
  await app.register(authPlugin);
  await app.register(auditPlugin);
  await app.register(installProgressPlugin);
  await app.register(statusReconcilerPlugin);
  await app.register(orphanSweepPlugin);

  await app.register(authRoutes);
  await app.register(meTokensRoutes);
  await app.register(messageTemplatesRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(hostBackupRoutes);
  await app.register(serverRoutes);
  await app.register(serverRosterRoutes);
  await app.register(serverSeedingRoutes);
  await app.register(serverSeedScheduleRoutes);
  await app.register(serverScheduledTasksRoutes);
  await app.register(serverChatCommandsRoutes);
  await app.register(serverSeedNotificationRoutes);
  await app.register(serverSettingsRoutes);
  await app.register(serverUpdateRoutes);
  await app.register(archiveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverRnsquadjsRoutes);
  await app.register(forceStopRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverLogFilesRoutes);
  await app.register(serverMapRoutes);
  await app.register(serverMapVoteRoutes);
  await app.register(serverMessagingRoutes);
  await app.register(serverMetricsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(serverRotationRoutes);
  await app.register(serverRotationCalendarRoutes);
  await app.register(depotRoutes);
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(roleMembersRoutes);
  await app.register(roleAssignmentsRoutes);
  await app.register(usersRoutes);
  await app.register(playerRoutes);
  await app.register(issuesRoutes);
  await app.register(marksRoutes);
  await app.register(markTypesRoutes);
  await app.register(suspectsRoutes);
  await app.register(matchesRoutes);
  await app.register(playerMatchesRoutes);
  await app.register(playerPresenceRoutes);
  await app.register(playerCompareOnlineRoutes);
  await app.register(playerSeedContributionRoutes);
  await app.register(playerSteamFriendCheckRoutes);
  await app.register(playerCoplayRoutes);
  await app.register(playerAltCandidatesRoutes);
  await app.register(playerBanAltWarningRoutes);
  await app.register(playerLinksRoutes);
  await app.register(moderationActionsRoutes);
  await app.register(moderationBulkRoutes);
  await app.register(playerDossierRoutes);
  await app.register(playerDossierStatsRoutes);
  await app.register(playerCombatTrendRoutes);
  await app.register(playerGeoAnomaliesRoutes);
  await app.register(leaderboardsRoutes);
  await app.register(leaderboardsBonusesRoutes);
  await app.register(economyRoutes);
  await app.register(mediaRoutes);
  await app.register(mediaLinksRoutes);
  await app.register(settingsEconomyRoutes);
  await app.register(settingsChatFlagsRoutes);
  await app.register(settingsClanGuardRoutes);
  await app.register(settingsAltDetectionRoutes);
  await app.register(settingsBanlistPublicationRoutes);
  await app.register(settingsCoplayRoutes);
  await app.register(clansRoutes);
  await app.register(chatRoutes);
  await app.register(combatEventsRoutes);
  await app.register(teamkillsRoutes);
  await app.register(vehicleCatalogRoutes);
  await app.register(layersRoutes);
  await app.register(vipTiersRoutes);
  await app.register(votesRoutes);
  await app.register(voteAnalyticsRoutes);
  await app.register(reportsRoutes);
  await app.register(reportActionsRoutes);
  await app.register(reportAnalyticsRoutes);
  await app.register(eventsRoutes);
  await app.register(playerNotesRoutes);
  await app.register(notesFeedRoutes);
  await app.register(adminsCfgRoutes);
  await app.register(bannedNamesRoutes);
  await app.register(banSourcesRoutes);
  await app.register(externalBansRoutes);
  await app.register(alertRulesRoutes);
  await app.register(automationRulesRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);
  await app.register(integrationsDiscordRoutes);
  await app.register(integrationsGeoipRoutes);
  await app.register(liveRoutes);
  await app.register(analyticsRoutes);
  await app.register(publicStatsRoutes);
  await app.register(publicClansRoutes);
  await app.register(publicBanlistRoutes);
  await app.register(steamRoutes);
  await app.register(setupRoutes);
  await app.register(integrationsVipRoutes);
  await app.register(whitelistRoutes);
  await app.register(whitelistApplicationsRoutes);

  return app;
}
