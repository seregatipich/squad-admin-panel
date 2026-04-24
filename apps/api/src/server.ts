import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import { loadEncryptionKey } from './lib/crypto.js';
import { buildLogger } from './lib/logger.js';
import auditPlugin from './plugins/audit.js';
import authPlugin from './plugins/auth.js';
import bridgePlugin from './plugins/bridge.js';
import databasePlugin from './plugins/database.js';
import healthPlugin from './plugins/health.js';
import installProgressPlugin from './plugins/install-progress.js';
import metricsPlugin from './plugins/metrics.js';
import redisPlugin from './plugins/redis.js';
import requestContextPlugin from './plugins/request-context.js';
import statusReconcilerPlugin from './plugins/status-reconciler.js';
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import discordRoutes from './routes/auth-discord.js';
import steamRoutes from './routes/auth-steam.js';
import depotRoutes from './routes/depot.js';
import hostRoutes from './routes/host.js';
import hostActionsRoutes from './routes/host-actions.js';
import playerRoutes from './routes/players.js';
import serverConfigRoutes from './routes/server-configs.js';
import serverInstallRoutes from './routes/server-install.js';
import serverLogsRoutes from './routes/server-logs.js';
import serverRoutes from './routes/servers.js';
import setupRoutes from './routes/setup.js';

// Side-effect import: augments the Fastify types with our plugin context.
import './plugins/types.js';

export async function buildServer(config: AppConfig) {
  const logger = buildLogger(config.LOG_LEVEL);
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

  await app.register(helmet, { global: true });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, {
    max: 1200,
    timeWindow: '1 minute',
    keyGenerator: (req) => `${req.ip}:${req.user?.id ?? ''}`,
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
  await app.register(bridgePlugin, { config });
  await app.register(metricsPlugin);
  await app.register(healthPlugin);
  await app.register(authPlugin);
  await app.register(auditPlugin);
  await app.register(installProgressPlugin);
  await app.register(statusReconcilerPlugin);

  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(auditRoutes);
  await app.register(steamRoutes);
  await app.register(discordRoutes);

  return app;
}
