import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { redisSinkStream } from '@squad/shared-config';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import { loadEncryptionKey } from './lib/crypto.js';
import diagPlugin from './lib/diag.js';
import { buildLogger, shouldDisableSensitiveAuthRequestLogging } from './lib/logger.js';
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
import { registerRoutes } from './routes/index.js';

// Side-effect import: augments the Fastify types with our plugin context.
import './plugins/types.js';

export async function buildServer(config: AppConfig) {
  const { logger, lateSink } = buildLogger(config.LOG_LEVEL);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    disableRequestLogging: shouldDisableSensitiveAuthRequestLogging,
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
  // No `config`/`uiHooks` needed here (#246): `authPlugin`'s `onRequest` hook is
  // registered with `fastify-plugin` (`fp()`), so it is NOT encapsulated to its
  // registration point — Fastify applies it at the root scope to every route on
  // this instance, including these swagger-ui routes, regardless of the order
  // `register()` calls happen in. The routes carry no `config.public`/
  // `config.permissions`, so they fall through to the fail-closed default and
  // require a session like the rest of the API.
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

  await registerRoutes(app as unknown as FastifyInstance);

  return app;
}
