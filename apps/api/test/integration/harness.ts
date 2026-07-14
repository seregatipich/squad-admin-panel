import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { auditLog, players, roles } from '@squad/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import diagPlugin from '../../src/lib/diag.js';
import { MEDIA_MAX_UPLOAD_BYTES } from '../../src/lib/media-storage.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import auditPluginFactory from '../../src/plugins/audit.js';
import authPlugin from '../../src/plugins/auth.js';
import errorDiagPlugin from '../../src/plugins/error-diag.js';
import healthPlugin from '../../src/plugins/health.js';
import heartbeatWatchPlugin from '../../src/plugins/heartbeat-watch.js';
import installProgressPlugin from '../../src/plugins/install-progress.js';
import liveBusPlugin from '../../src/plugins/live-bus.js';
import requestContextPlugin from '../../src/plugins/request-context.js';
import statusReconcilerPlugin from '../../src/plugins/status-reconciler.js';
import adminsCfgRoutes from '../../src/routes/admins-cfg.js';
import alertRulesRoutes from '../../src/routes/alert-rules.js';
import analyticsRoutes from '../../src/routes/analytics.js';
import auditRoutes from '../../src/routes/audit.js';
import authRoutes from '../../src/routes/auth.js';
import banSourcesRoutes from '../../src/routes/ban-sources.js';
import bannedNamesRoutes from '../../src/routes/banned-names.js';
import chatRoutes from '../../src/routes/chat.js';
import clansRoutes from '../../src/routes/clans.js';
import combatEventsRoutes from '../../src/routes/combat-events.js';
import depotRoutes from '../../src/routes/depot.js';
import economyRoutes from '../../src/routes/economy.js';
import eventsRoutes from '../../src/routes/events.js';
import hostRoutes from '../../src/routes/host.js';
import hostActionsRoutes from '../../src/routes/host-actions.js';
import integrationsDiscordRoutes from '../../src/routes/integrations-discord.js';
import integrationsGeoipRoutes from '../../src/routes/integrations-geoip.js';
import integrationsVipRoutes from '../../src/routes/integrations-vip.js';
import issuesRoutes from '../../src/routes/issues.js';
import layersRoutes from '../../src/routes/layers.js';
import leaderboardsRoutes from '../../src/routes/leaderboards.js';
import logsRoutes from '../../src/routes/logs.js';
import markTypesRoutes from '../../src/routes/mark-types.js';
import marksRoutes from '../../src/routes/marks.js';
import matchesRoutes from '../../src/routes/matches.js';
import meTokensRoutes from '../../src/routes/me-tokens.js';
import mediaRoutes from '../../src/routes/media.js';
import messageTemplatesRoutes from '../../src/routes/message-templates.js';
import moderationActionsRoutes from '../../src/routes/moderation-actions.js';
import notesFeedRoutes from '../../src/routes/notes-feed.js';
import permissionsRoutes from '../../src/routes/permissions.js';
import playerAltCandidatesRoutes from '../../src/routes/player-alt-candidates.js';
import playerCoplayRoutes from '../../src/routes/player-coplay.js';
import playerDossierStatsRoutes from '../../src/routes/player-dossier-stats.js';
import playerGeoAnomaliesRoutes from '../../src/routes/player-geo-anomalies.js';
import playerMatchesRoutes from '../../src/routes/player-matches.js';
import playerNotesRoutes from '../../src/routes/player-notes.js';
import playerPresenceRoutes from '../../src/routes/player-presence.js';
import playerRoutes from '../../src/routes/players.js';
import publicStatsRoutes from '../../src/routes/public-stats.js';
import reportActionsRoutes from '../../src/routes/report-actions.js';
import reportsRoutes from '../../src/routes/reports.js';
import roleAssignmentsRoutes from '../../src/routes/role-assignments.js';
import roleMembersRoutes from '../../src/routes/role-members.js';
import rolesRoutes from '../../src/routes/roles.js';
import archiveRoutes from '../../src/routes/server-archive.js';
import serverConfigRoutes from '../../src/routes/server-configs.js';
import forceStopRoutes from '../../src/routes/server-force-stop.js';
import serverInstallRoutes from '../../src/routes/server-install.js';
import serverLogsRoutes from '../../src/routes/server-logs.js';
import serverMessagingRoutes from '../../src/routes/server-messaging.js';
import serverMetricsRoutes from '../../src/routes/server-metrics.js';
import serverRosterRoutes from '../../src/routes/server-roster.js';
import serverSettingsRoutes from '../../src/routes/server-settings.js';
import serverUpdateRoutes from '../../src/routes/server-update.js';
import serverRoutes from '../../src/routes/servers.js';
import settingsAltDetectionRoutes from '../../src/routes/settings-alt-detection.js';
import settingsChatFlagsRoutes from '../../src/routes/settings-chat-flags.js';
import settingsClanGuardRoutes from '../../src/routes/settings-clan-guard.js';
import settingsEconomyRoutes from '../../src/routes/settings-economy.js';
import suspectsRoutes from '../../src/routes/suspects.js';
import teamkillsRoutes from '../../src/routes/teamkills.js';
import usersRoutes from '../../src/routes/users.js';
import vehicleCatalogRoutes from '../../src/routes/vehicle-catalog.js';
import vipTiersRoutes from '../../src/routes/vip-tiers.js';
import voteAnalyticsRoutes from '../../src/routes/vote-analytics.js';
import votesRoutes from '../../src/routes/votes.js';
import whitelistRoutes from '../../src/routes/whitelist.js';
import { createIsolatedSchema, hostDbUrl, hostRedisUrl } from './isolated-db.js';

export { createIsolatedSchema };
export { runMigrations, testDbUrl, testRedisUrl } from './isolated-db.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString('base64');
const TEST_SESSION_SECRET = 'a'.repeat(48);

// Fake implementations of every public method on `@squad/bridge-client`
// BridgeClient; signatures must match so routes that accept `app.bridge` work.
// Arguments are passed as params objects (e.g. `{ path }`) and responses match
// the shapes declared in packages/bridge-client/src/types.ts.
export interface FakeBridge {
  ping: () => Promise<{ pong: true; version: string; hostname: string }>;
  hostInfo: () => Promise<{
    hostname: string;
    os_name: string;
    os_version: string;
    kernel: string;
    arch: string;
    cpu_model: string;
    cpu_cores: number;
    ram_total_bytes: number;
    uptime_seconds: number;
    docker_version: string;
    ip_addresses: string[];
  }>;
  hostMetrics: () => Promise<{
    cpu_percent: number;
    ram_used_bytes: number;
    ram_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    net_rx_bytes_per_sec: number;
    net_tx_bytes_per_sec: number;
    load_avg_1m: number;
    load_avg_5m: number;
    load_avg_15m: number;
    sampled_at: string;
  }>;
  fileRead: (p: { path: string }) => Promise<{ content: string }>;
  fileWrite: (p: { path: string; content: string; mode?: number }) => Promise<{ status: string }>;
  fileAtomicWrite: (p: {
    path: string;
    content: string;
    mode?: number;
  }) => Promise<{ status: string }>;
  containerInspect: (p: { name: string }) => Promise<{
    name: string;
    state: string;
    running: boolean;
    pid: number;
    started_at: string;
    finished_at: string;
    exit_code: number;
    image: string;
    restart_count: number;
    labels: Record<string, string>;
    oom_killed?: boolean;
    error?: string;
  }>;
  containerStats: (p: { name: string }) => Promise<{
    name: string;
    found: boolean;
    cpu_percent: number;
    mem_used_bytes: number;
    mem_limit_bytes: number;
    mem_percent: number;
    pids: number;
    sampled_at: string;
  }>;
  containerRun: (
    p: Record<string, unknown>,
  ) => Promise<{ container_id: string; status: 'started' }>;
  containerRunRnsquadjs: (p: {
    server_id: string;
    env: Record<string, string>;
  }) => Promise<{ container_id: string; status: 'started' }>;
  containerStart: (p: { name: string }) => Promise<{ status: string }>;
  containerStop: (p: { name: string; timeout_sec?: number }) => Promise<{ status: string }>;
  containerRm: (p: { name: string; force?: boolean }) => Promise<{ status: string }>;
  containerLogsFollow: (
    p: { name: string; tail?: number },
    onStream: (frame: { id: string; stream: 'stdout' | 'stderr' | 'event'; data: unknown }) => void,
  ) => Promise<{ exit_code: number }>;
  depotUpdate: (
    onStream: (frame: { id: string; stream: 'stdout' | 'stderr' | 'event'; data: unknown }) => void,
  ) => Promise<{ exit_code: number }>;
  ufwRule: (p: {
    action: 'add' | 'remove';
    port: number;
    proto: 'tcp' | 'udp';
    comment?: string;
  }) => Promise<{ output: string; status: string }>;
  directoryDelete: (p: { path: string }) => Promise<{ removed: boolean }>;
  processInfo: (p: { pid: number }) => Promise<{ pid: number; exists: boolean }>;
  hostAgentRestart: () => Promise<{ status: 'restarting' }>;
  panelDiskUsage: (opts?: { force?: boolean }) => Promise<{
    configs_bytes: number;
    saved_total_bytes: number;
    saved_per_server: Array<{ uuid: string; bytes: number }>;
    depot_volume_bytes: number;
    docker_volumes: Array<{ name: string; bytes: number }>;
    docker_images: Array<{ repository: string; tag: string; bytes: number }>;
    audit_archive_bytes: number;
    total_panel_bytes: number;
    host_total_bytes: number;
    host_used_bytes: number;
    computed_at: string;
    cache_age_seconds: number;
  }>;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Overridable in-memory file store; routes use /api/v1/servers/:id/configs
   *  read/write pathways that hit this map via `fileRead`/`fileAtomicWrite`. */
  files: Map<string, Buffer>;
}

export type FakeBridgeOverrides = Partial<FakeBridge>;

export function makeFakeBridge(overrides: FakeBridgeOverrides = {}): FakeBridge {
  const files = new Map<string, Buffer>();
  const base: FakeBridge = {
    files,
    async connect() {},
    async close() {},
    ping: async () => ({ pong: true, version: 'test', hostname: 'test-host' }),
    hostInfo: async () => ({
      hostname: 'test-host',
      os_name: 'Ubuntu',
      os_version: '24.04',
      kernel: '6.8',
      arch: 'x86_64',
      cpu_model: 'test-cpu',
      cpu_cores: 8,
      ram_total_bytes: 16 * 1024 ** 3,
      uptime_seconds: 3600,
      docker_version: 'Docker version 27.5.1, build 9f9e405',
      ip_addresses: ['10.0.0.1'],
    }),
    hostMetrics: async () => ({
      cpu_percent: 1,
      ram_used_bytes: 1024 ** 3,
      ram_total_bytes: 16 * 1024 ** 3,
      disk_used_bytes: 10 * 1024 ** 3,
      disk_total_bytes: 100 * 1024 ** 3,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
      sampled_at: new Date().toISOString(),
    }),
    fileRead: async ({ path }) => {
      const buf = files.get(path);
      if (!buf) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { content: buf.toString('utf-8') };
    },
    fileWrite: async ({ path, content }) => {
      files.set(path, Buffer.from(content, 'utf-8'));
      return { status: 'ok' };
    },
    fileAtomicWrite: async ({ path, content }) => {
      files.set(path, Buffer.from(content, 'utf-8'));
      return { status: 'ok' };
    },
    containerInspect: async ({ name }) => ({
      name,
      state: 'running',
      running: true,
      pid: 1,
      started_at: new Date().toISOString(),
      finished_at: '',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    }),
    containerStats: async ({ name }) => ({
      name,
      found: true,
      cpu_percent: 12.5,
      mem_used_bytes: 2 * 1024 ** 3,
      mem_limit_bytes: 16 * 1024 ** 3,
      mem_percent: 12.5,
      pids: 20,
      sampled_at: new Date().toISOString(),
    }),
    containerRun: async () => ({ container_id: 'fake-container-id', status: 'started' }),
    containerRunRnsquadjs: async () => ({ container_id: 'fake-rnsquadjs-id', status: 'started' }),
    containerStart: async () => ({ status: 'ok' }),
    containerStop: async () => ({ status: 'ok' }),
    containerRm: async () => ({ status: 'ok' }),
    containerLogsFollow: async () => ({ exit_code: 0 }),
    depotUpdate: async () => ({ exit_code: 0 }),
    ufwRule: async () => ({ output: '', status: 'ok' }),
    directoryDelete: async () => ({ removed: true }),
    processInfo: async ({ pid }) => ({ pid, exists: true }),
    hostAgentRestart: async () => ({ status: 'restarting' as const }),
    panelDiskUsage: async () => ({
      configs_bytes: 0,
      saved_total_bytes: 0,
      saved_per_server: [],
      depot_volume_bytes: 0,
      docker_volumes: [],
      docker_images: [],
      audit_archive_bytes: 0,
      total_panel_bytes: 0,
      host_total_bytes: 0,
      host_used_bytes: 0,
      computed_at: new Date().toISOString(),
      cache_age_seconds: 0,
    }),
  };
  return { ...base, ...overrides, files };
}

export interface BuildAppOptions {
  /** A fake bridge instance; defaults to `makeFakeBridge()`. */
  bridge?: FakeBridge;
  /** Whether to seed an owner player (roles come from migration 0009). */
  seedOwner?: { steamId64: bigint; canonicalName?: string };
  /** Whether to run status-reconciler + other heavy plugins. Off by default. */
  withStatusReconciler?: boolean;
  /**
   * Run against the already-migrated shared `public` schema instead of a
   * fresh isolated schema. Requires the target database to be migrated ahead
   * of time (e.g. `db:migrate`). Use for suites that need the hand-authored
   * wave-5 tables, whose `public`-qualified DDL cannot be replayed into an
   * isolated schema. Isolate such suites with their own dedicated database.
   */
  reusePublicSchema?: boolean;
}

export interface IntegrationHarness {
  app: FastifyInstance;
  db: DatabaseClient;
  redis: Redis;
  bridge: FakeBridge;
  url: string;
  schema: string;
  mediaDir: string;
  cleanup: () => Promise<void>;
  seed: {
    ownerSteamId64?: bigint;
    ownerPlayerId?: string;
  };
}

export async function buildIntegrationApp(opts: BuildAppOptions = {}): Promise<IntegrationHarness> {
  const schemaInfo = opts.reusePublicSchema
    ? { schema: 'public', url: hostDbUrl(), drop: async () => undefined }
    : await createIsolatedSchema();

  // Hand-build the drizzle client with a tighter connection pool so a
  // parallel-run test suite doesn't overwhelm the shared live Postgres.
  const sql = postgres(schemaInfo.url, { max: 2, onnotice: () => undefined });
  const db = drizzlePostgres(sql, { schema }) as unknown as DatabaseClient;
  const redis = new Redis(hostRedisUrl());
  const bridge = opts.bridge ?? makeFakeBridge();
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'squad-media-test-'));

  const app = Fastify({ logger: false });
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
    COOKIE_SECURE: false,
    APP_DOMAIN: 'test.localhost',
    LOG_LEVEL: 'info',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
    MEDIA_STORAGE_DIR: mediaDir,
  });
  app.decorate('encryptionKey', Buffer.from(TEST_ENCRYPTION_KEY, 'base64'));
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', bridge);
  app.decorate('makeBridgeClient', () => bridge);

  await app.register(cookie, { secret: TEST_SESSION_SECRET });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(requestContextPlugin);
  await app.register(diagPlugin);
  await app.register(errorDiagPlugin);
  await app.register(heartbeatWatchPlugin);
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

  await app.register(authRoutes);
  await app.register(meTokensRoutes);
  await app.register(messageTemplatesRoutes);
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(roleMembersRoutes);
  await app.register(roleAssignmentsRoutes);
  await app.register(usersRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(serverRosterRoutes);
  await app.register(serverSettingsRoutes);
  await app.register(serverUpdateRoutes);
  await app.register(archiveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(forceStopRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverMessagingRoutes);
  await app.register(serverMetricsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(issuesRoutes);
  await app.register(marksRoutes);
  await app.register(markTypesRoutes);
  await app.register(suspectsRoutes);
  await app.register(matchesRoutes);
  await app.register(playerMatchesRoutes);
  await app.register(playerPresenceRoutes);
  await app.register(playerCoplayRoutes);
  await app.register(playerAltCandidatesRoutes);
  await app.register(playerDossierStatsRoutes);
  await app.register(playerGeoAnomaliesRoutes);
  await app.register(leaderboardsRoutes);
  await app.register(economyRoutes);
  await app.register(mediaRoutes);
  await app.register(settingsEconomyRoutes);
  await app.register(settingsChatFlagsRoutes);
  await app.register(settingsClanGuardRoutes);
  await app.register(settingsAltDetectionRoutes);
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
  await app.register(moderationActionsRoutes);
  await app.register(eventsRoutes);
  await app.register(playerNotesRoutes);
  await app.register(notesFeedRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);
  await app.register(integrationsDiscordRoutes);
  await app.register(integrationsGeoipRoutes);
  await app.register(integrationsVipRoutes);
  await app.register(adminsCfgRoutes);
  await app.register(analyticsRoutes);
  await app.register(publicStatsRoutes);
  await app.register(bannedNamesRoutes);
  await app.register(banSourcesRoutes);
  await app.register(alertRulesRoutes);
  await app.register(whitelistRoutes);

  // Test fixture: legacy "Viewer" role used by older permission-bound
  // tests (depot, host-actions, logs, rbac, ...). The production seed
  // (migration 0015) intentionally does not include Viewer; we (re)create
  // it here for every integration harness so those tests keep passing
  // without each having to call the helper themselves.
  await (await import('../helpers/viewer-fixture.js')).ensureViewerFixture(db);

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
      .values({
        steamId64: ownerSteamId64,
        canonicalName,
        canonicalNameNormalized: canonicalName.toLowerCase(),
        roleId: ownerRoleId,
      })
      .returning({ id: players.id });
    seed.ownerSteamId64 = ownerSteamId64;
    seed.ownerPlayerId = insertedPlayers[0]?.id;
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

/**
 * Creates a real session for the seeded owner and returns the cookie header
 * string ready for subsequent `inject()` calls.
 */
export async function loginAsOwner(h: IntegrationHarness): Promise<string> {
  if (!h.seed.ownerPlayerId) {
    throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
  }
  invalidatePermissionCache(h.seed.ownerPlayerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId: h.seed.ownerPlayerId,
    ip: null,
    userAgent: 'test-harness',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

/**
 * Asserts that an audit_log row exists matching the given action+target with
 * created_at within the last `withinMs` milliseconds. Polls up to ~1s because
 * Fastify's `onResponse` audit hook runs after `inject()` resolves.
 */
export async function assertAuditRow(
  h: IntegrationHarness,
  expected: { action: string; resource?: string; targetId?: string | null; withinMs?: number },
): Promise<typeof auditLog.$inferSelect> {
  const withinMs = expected.withinMs ?? 5_000;
  const cutoff = new Date(Date.now() - withinMs);
  const deadline = Date.now() + 1_200;
  const filters = () =>
    and(
      eq(auditLog.actionType, expected.action),
      gte(auditLog.createdAt, cutoff),
      ...(expected.resource ? [eq(auditLog.targetType, expected.resource)] : []),
      ...(expected.targetId != null ? [eq(auditLog.targetId, expected.targetId)] : []),
    );
  // Polling loop — onResponse hook completes shortly after inject resolves.
  while (Date.now() < deadline) {
    const rows = await h.db
      .select()
      .from(auditLog)
      .where(filters())
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const first = rows[0];
    if (first) return first;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `expected audit row with action=${expected.action} resource=${expected.resource ?? 'any'} within ${withinMs}ms; none found after polling`,
  );
}
