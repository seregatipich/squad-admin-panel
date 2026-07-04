import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
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
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import steamRoutes from './routes/auth-steam.js';
import bannedNamesRoutes from './routes/banned-names.js';
import depotRoutes from './routes/depot.js';
import hostRoutes from './routes/host.js';
import hostActionsRoutes from './routes/host-actions.js';
import issuesRoutes from './routes/issues.js';
import liveRoutes from './routes/live.js';
import logsRoutes from './routes/logs.js';
import meTokensRoutes from './routes/me-tokens.js';
import permissionsRoutes from './routes/permissions.js';
import playerRoutes from './routes/players.js';
import roleMembersRoutes from './routes/role-members.js';
import rolesRoutes from './routes/roles.js';
import archiveRoutes from './routes/server-archive.js';
import serverConfigRoutes from './routes/server-configs.js';
import forceStopRoutes from './routes/server-force-stop.js';
import serverInstallRoutes from './routes/server-install.js';
import serverLogsRoutes from './routes/server-logs.js';
import serverMetricsRoutes from './routes/server-metrics.js';
import serverRnsquadjsRoutes from './routes/server-rnsquadjs.js';
import serverSettingsRoutes from './routes/server-settings.js';
import serverUpdateRoutes from './routes/server-update.js';
import serverRoutes from './routes/servers.js';
import setupRoutes from './routes/setup.js';
import usersRoutes from './routes/users.js';

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
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(serverSettingsRoutes);
  await app.register(serverUpdateRoutes);
  await app.register(archiveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverRnsquadjsRoutes);
  await app.register(forceStopRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverMetricsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(roleMembersRoutes);
  await app.register(usersRoutes);
  await app.register(playerRoutes);
  await app.register(issuesRoutes);
  await app.register(adminsCfgRoutes);
  await app.register(bannedNamesRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);
  await app.register(liveRoutes);
  await app.register(steamRoutes);
  await app.register(setupRoutes);

  return app;
}
