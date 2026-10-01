/** Builds the Fastify app, isolated database and fake bridge a suite runs against. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { players, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import diagPlugin from '../../../src/lib/diag.js';
import { MEDIA_MAX_UPLOAD_BYTES } from '../../../src/lib/media-storage.js';
import auditPluginFactory from '../../../src/plugins/audit.js';
import authPlugin from '../../../src/plugins/auth.js';
import csrfPlugin from '../../../src/plugins/csrf.js';
import errorDiagPlugin from '../../../src/plugins/error-diag.js';
import healthPlugin from '../../../src/plugins/health.js';
import heartbeatWatchPlugin from '../../../src/plugins/heartbeat-watch.js';
import installProgressPlugin from '../../../src/plugins/install-progress.js';
import liveBusPlugin from '../../../src/plugins/live-bus.js';
import requestContextPlugin, { genRequestId } from '../../../src/plugins/request-context.js';
import statusReconcilerPlugin from '../../../src/plugins/status-reconciler.js';
import websocketPlugin from '../../../src/plugins/websocket.js';
import { registerRoutes } from '../../../src/routes/index.js';
import { createIsolatedSchema, ensureWorkerDatabase, hostRedisUrl } from '../isolated-db.js';
import { makeFakeBridge } from './fake-bridge.js';
import type { BuildAppOptions, IntegrationHarness } from './types.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString('base64');
const TEST_SESSION_SECRET = 'a'.repeat(48);

export async function buildIntegrationApp(opts: BuildAppOptions = {}): Promise<IntegrationHarness> {
  // The worker database behind TEST_DATABASE_URL is cloned on demand, so a
  // file that only reaches it through this option still gets it provisioned.
  const schemaInfo = opts.reusePublicSchema
    ? { schema: 'public', url: await ensureWorkerDatabase(), drop: async () => undefined }
    : await createIsolatedSchema();

  // Hand-build the drizzle client with a tighter connection pool so a
  // parallel-run test suite doesn't overwhelm the shared live Postgres.
  const sql = postgres(schemaInfo.url, { max: 2, onnotice: () => undefined });
  const db = drizzlePostgres(sql, { schema }) as unknown as DatabaseClient;
  const redis = new Redis(hostRedisUrl());
  const bridge = opts.bridge ?? makeFakeBridge();
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'squad-media-test-'));

  const app = Fastify({ logger: false, genReqId: genRequestId });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', {
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    DATABASE_URL: schemaInfo.url,
    REDIS_URL: hostRedisUrl(),
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
    BRIDGE_SOCKET: '/dev/null',
    APP_DOMAIN: 'test.localhost',
    LOG_LEVEL: 'info',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
    MEDIA_STORAGE_DIR: mediaDir,
    HOST_ORPHAN_SWEEP_INTERVAL_MS: 5 * 60_000,
    HOST_DOCKER_PRUNE_INTERVAL_MS: 24 * 60 * 60_000,
    // OAuth round-trip config (DISCORD-4) and the origin the delegated-upload
    // link is built against (VIDEO-3): both need a public origin, and the
    // Discord routes also need client credentials to build their redirects.
    // The values are inert — every outbound call is faked by the test.
    PANEL_PUBLIC_URL: 'https://panel.test',
    DISCORD_PUBLIC_KEY: opts.discordInteractionsPublicKey,
    DISCORD_CLIENT_ID: 'test-discord-client-id',
    DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
  });
  app.decorate('encryptionKey', Buffer.from(TEST_ENCRYPTION_KEY, 'base64'));
  app.decorate('db', db);
  app.decorate('redis', redis);
  // FakeBridge implements the RPC surface routes call, not the socket internals.
  app.decorate('bridge', bridge as unknown as BridgeClient);
  app.decorate('makeBridgeClient', () => bridge as unknown as BridgeClient);

  await app.register(cookie, { secret: TEST_SESSION_SECRET });
  await app.register(websocketPlugin, { allowedOrigin: 'https://panel.test' });
  await app.register(multipart, { limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(requestContextPlugin);
  await app.register(diagPlugin);
  // Many harness apps share one vitest process: report unhandled rejections
  // but leave failing the run to vitest instead of exiting the worker.
  await app.register(errorDiagPlugin, { exitOnUnhandledRejection: false });
  await app.register(heartbeatWatchPlugin);
  await app.register(csrfPlugin);
  await app.register(authPlugin);
  await app.register(auditPluginFactory);
  await app.register(installProgressPlugin);
  await app.register(liveBusPlugin);
  await app.register(healthPlugin);
  if (opts.withStatusReconciler) {
    await app.register(statusReconcilerPlugin);
  } else {
    // Tests that don't exercise the reconciler still need the decorator so
    // routes that consult `app.statusReconciler` (e.g. POST /reconcile)
    // resolve. Provide a no-op stub.
    app.decorate('statusReconciler', {
      stats: async () => ({
        last_tick_at: null,
        last_tick_duration_ms: null,
        last_tick_servers_inspected: 0,
        last_tick_budget_exceeded: false,
        consecutive_tick_errors: 0,
        servers_in_transient: 0,
        stuck_servers: [],
        stale_installs_failed: 0,
        bridge_failures_by_server: {},
      }),
      reconcileOnce: async () => null,
      tickNow: async () => undefined,
    });
  }

  await registerRoutes(app);

  // Test fixture: legacy "Viewer" role used by older permission-bound
  // tests (depot, host-actions, logs, rbac, ...). The production seed
  // (migration 0015) intentionally does not include Viewer; we (re)create
  // it here for every integration harness so those tests keep passing
  // without each having to call the helper themselves.
  await (await import('../../helpers/viewer-fixture.js')).ensureViewerFixture(db);

  const seed: IntegrationHarness['seed'] = {};
  if (opts.seedOwner) {
    const ownerSteamId64 = opts.seedOwner.steamId64;
    const canonicalName = opts.seedOwner.canonicalName ?? 'Owner';
    const ownerRows = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRows[0]?.id;
    if (!ownerRoleId) throw new Error('Owner role missing — migration 0009 not applied?');
    const insertedPlayers = await db
      .insert(players)
      .values([
        {
          steamId64: ownerSteamId64,
          canonicalName,
          canonicalNameNormalized: canonicalName.toLowerCase(),
          roleId: ownerRoleId,
        },
        ...(opts.seedOwnerGuard === true
          ? [
              {
                steamId64: null,
                canonicalName: 'Integration Owner Guard',
                canonicalNameNormalized: 'integration owner guard',
                roleId: ownerRoleId,
              },
            ]
          : []),
      ])
      .returning({ id: players.id, steamId64: players.steamId64 });
    seed.ownerSteamId64 = ownerSteamId64;
    seed.ownerPlayerId = insertedPlayers.find((player) => player.steamId64 === ownerSteamId64)?.id;
  }

  await app.ready();

  return {
    app,
    db,
    redis,
    bridge,
    url: schemaInfo.url,
    schema: schemaInfo.schema,
    mediaDir,
    seed,
    async cleanup() {
      await app.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await schemaInfo.drop().catch(() => undefined);
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}
