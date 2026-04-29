import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
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
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import auditPluginFactory from '../../src/plugins/audit.js';
import authPlugin from '../../src/plugins/auth.js';
import healthPlugin from '../../src/plugins/health.js';
import installProgressPlugin from '../../src/plugins/install-progress.js';
import liveBusPlugin from '../../src/plugins/live-bus.js';
import requestContextPlugin from '../../src/plugins/request-context.js';
import statusReconcilerPlugin from '../../src/plugins/status-reconciler.js';
import adminsCfgRoutes from '../../src/routes/admins-cfg.js';
import auditRoutes from '../../src/routes/audit.js';
import authRoutes from '../../src/routes/auth.js';
import depotRoutes from '../../src/routes/depot.js';
import hostRoutes from '../../src/routes/host.js';
import hostActionsRoutes from '../../src/routes/host-actions.js';
import logsRoutes from '../../src/routes/logs.js';
import meTokensRoutes from '../../src/routes/me-tokens.js';
import permissionsRoutes from '../../src/routes/permissions.js';
import playerRoutes from '../../src/routes/players.js';
import roleMembersRoutes from '../../src/routes/role-members.js';
import rolesRoutes from '../../src/routes/roles.js';
import archiveRoutes from '../../src/routes/server-archive.js';
import serverConfigRoutes from '../../src/routes/server-configs.js';
import serverInstallRoutes from '../../src/routes/server-install.js';
import serverLogsRoutes from '../../src/routes/server-logs.js';
import serverRoutes from '../../src/routes/servers.js';
import usersRoutes from '../../src/routes/users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../../packages/db/drizzle');
const REPO_ENV_FILE = path.resolve(__dirname, '../../../../.env');

function dotenvLookup(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const raw = readFileSync(REPO_ENV_FILE, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (m && m[1] === key) return m[2]?.replace(/^"(.*)"$/, '$1');
    }
  } catch {
    // .env missing is fine; caller must set env
  }
  return undefined;
}

const DB_PASSWORD =
  dotenvLookup('POSTGRES_PASSWORD') ??
  (() => {
    const url = dotenvLookup('DATABASE_URL');
    if (url) {
      const m = url.match(/^postgres:\/\/[^:]+:([^@]+)@/);
      if (m) return m[1];
    }
    return 'admin';
  })();

const HOST_DB_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://admin:${DB_PASSWORD}@127.0.0.1:5432/admin`;
const HOST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString('base64');
const TEST_SESSION_SECRET = 'a'.repeat(48);
export const testDbUrl = HOST_DB_URL;
export const testRedisUrl = HOST_REDIS_URL;

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
  containerStart: (p: { name: string }) => Promise<{ status: string }>;
  containerStop: (p: { name: string; timeout_sec?: number }) => Promise<{ status: string }>;
  containerRm: (p: { name: string }) => Promise<{ status: string }>;
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
    containerStart: async () => ({ status: 'ok' }),
    containerStop: async () => ({ status: 'ok' }),
    containerRm: async () => ({ status: 'ok' }),
    containerLogsFollow: async () => ({ exit_code: 0 }),
    depotUpdate: async () => ({ exit_code: 0 }),
    ufwRule: async () => ({ output: '', status: 'ok' }),
    directoryDelete: async () => ({ removed: true }),
    processInfo: async ({ pid }) => ({ pid, exists: true }),
    hostAgentRestart: async () => ({ status: 'restarting' as const }),
  };
  return { ...base, ...overrides, files };
}

interface CreatedSchema {
  schema: string;
  url: string;
  drop: () => Promise<void>;
}

export async function createIsolatedSchema(): Promise<CreatedSchema> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(HOST_DB_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const url = `${HOST_DB_URL}?search_path=${schema}%2Cpublic`;
  return {
    schema,
    url,
    async drop() {
      const s = postgres(HOST_DB_URL, { max: 1, onnotice: () => undefined });
      try {
        await s.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await s.end();
      }
    },
  };
}

/**
 * Runs all `.sql` files under `packages/db/drizzle/`, in lexical order, through
 * the given connection. Drizzle's own migrator tracks applied migrations in a
 * shared `drizzle` schema — for schema-per-test isolation we bypass it and
 * re-execute the DDL against the fresh schema directly.
 *
 * The `.sql` files are split on the `--> statement-breakpoint` marker that
 * drizzle-kit emits when a migration contains multiple top-level statements.
 */
export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('SET client_min_messages = WARNING');
    const files = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const contents = readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf-8');
      const statements = contents
        .split(/-->\s*statement-breakpoint\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }
    }
  } finally {
    await sql.end();
  }
}

export interface BuildAppOptions {
  /** A fake bridge instance; defaults to `makeFakeBridge()`. */
  bridge?: FakeBridge;
  /** Whether to seed an owner player (roles come from migration 0009). */
  seedOwner?: { steamId64: bigint; canonicalName?: string };
  /** Whether to run status-reconciler + other heavy plugins. Off by default. */
  withStatusReconciler?: boolean;
}

export interface IntegrationHarness {
  app: FastifyInstance;
  db: DatabaseClient;
  redis: Redis;
  bridge: FakeBridge;
  url: string;
  schema: string;
  cleanup: () => Promise<void>;
  seed: {
    ownerSteamId64?: bigint;
  };
}

export async function buildIntegrationApp(opts: BuildAppOptions = {}): Promise<IntegrationHarness> {
  const schemaInfo = await createIsolatedSchema();
  await runMigrations(schemaInfo.url);

  // Hand-build the drizzle client with a tighter connection pool so a
  // parallel-run test suite doesn't overwhelm the shared live Postgres.
  const sql = postgres(schemaInfo.url, { max: 2, onnotice: () => undefined });
  const db = drizzlePostgres(sql, { schema }) as unknown as DatabaseClient;
  const redis = new Redis(HOST_REDIS_URL);
  const bridge = opts.bridge ?? makeFakeBridge();

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', {
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    DATABASE_URL: schemaInfo.url,
    REDIS_URL: HOST_REDIS_URL,
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
    BRIDGE_SOCKET: '/dev/null',
    COOKIE_SECURE: false,
    APP_DOMAIN: 'test.localhost',
    LOG_LEVEL: 'info',
    SESSION_TTL_SECONDS: 21600,
    SESSION_TOUCH_THROTTLE_SECONDS: 60,
  });
  app.decorate('encryptionKey', Buffer.from(TEST_ENCRYPTION_KEY, 'base64'));
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('bridge', bridge);
  app.decorate('makeBridgeClient', () => bridge);

  await app.register(cookie, { secret: TEST_SESSION_SECRET });
  await app.register(websocket);
  await app.register(requestContextPlugin);
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
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(roleMembersRoutes);
  await app.register(usersRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(archiveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);
  await app.register(adminsCfgRoutes);

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
    await db.insert(players).values({
      steamId64: ownerSteamId64,
      canonicalName,
      canonicalNameNormalized: canonicalName.toLowerCase(),
      roleId: ownerRoleId,
    });
    seed.ownerSteamId64 = ownerSteamId64;
  }

  await app.ready();

  return {
    app,
    db,
    redis,
    bridge,
    url: schemaInfo.url,
    schema: schemaInfo.schema,
    seed,
    async cleanup() {
      await app.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await schemaInfo.drop().catch(() => undefined);
    },
  };
}

/**
 * Creates a real session for the seeded owner and returns the cookie header
 * string ready for subsequent `inject()` calls.
 */
export async function loginAsOwner(h: IntegrationHarness): Promise<string> {
  if (!h.seed.ownerSteamId64) {
    throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
  }
  invalidatePermissionCache(h.seed.ownerSteamId64);
  const { token } = await createSession(h.db, h.redis, {
    steamId64: h.seed.ownerSteamId64,
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
