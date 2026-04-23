import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { createDatabaseClient, type DatabaseClient } from '@squad/db';
import { auditLog, users } from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import type { RoleName } from '@squad/shared-config';
import { and, desc, eq, gte } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import Redis from 'ioredis';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { hashPassword } from '../../src/lib/argon.js';
import auditPluginFactory from '../../src/plugins/audit.js';
import authPlugin from '../../src/plugins/auth.js';
import installProgressPlugin from '../../src/plugins/install-progress.js';
import requestContextPlugin from '../../src/plugins/request-context.js';
import auditRoutes from '../../src/routes/audit.js';
import authRoutes from '../../src/routes/auth.js';
import depotRoutes from '../../src/routes/depot.js';
import hostRoutes from '../../src/routes/host.js';
import playerRoutes from '../../src/routes/players.js';
import serverConfigRoutes from '../../src/routes/server-configs.js';
import serverInstallRoutes from '../../src/routes/server-install.js';
import serverLogsRoutes from '../../src/routes/server-logs.js';
import serverRoutes from '../../src/routes/servers.js';
import setupRoutes from '../../src/routes/setup.js';

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

export interface FakeBridgeOverrides {
  ping?: () => Promise<{ version: string; hostname: string; uptime_seconds: number }>;
  hostInfo?: () => Promise<{
    os_name: string;
    os_version: string;
    kernel: string;
    uptime_seconds: number;
  }>;
  hostMetrics?: () => Promise<Record<string, unknown>>;
  fileRead?: (path: string) => Promise<Buffer>;
  fileWrite?: (path: string, data: Buffer) => Promise<void>;
  fileAtomicWrite?: (path: string, data: Buffer) => Promise<void>;
  containerInspect?: (name: string) => Promise<Record<string, unknown>>;
  containerRun?: (spec: Record<string, unknown>) => Promise<{ container_id: string }>;
  containerStart?: (name: string) => Promise<void>;
  containerStop?: (name: string) => Promise<void>;
  containerRm?: (name: string) => Promise<void>;
  containerLogsFollow?: (
    name: string,
    cb: (line: string, stream: 'stdout' | 'stderr') => void,
  ) => { close(): void };
  depotUpdate?: (cb: (line: string) => void) => { close(): void; done: Promise<number> };
  ufwRule?: (op: string, rule: Record<string, unknown>) => Promise<void>;
  processInfo?: (pid: number) => Promise<Record<string, unknown>>;
}

export interface FakeBridge {
  ping: NonNullable<FakeBridgeOverrides['ping']>;
  hostInfo: NonNullable<FakeBridgeOverrides['hostInfo']>;
  hostMetrics: NonNullable<FakeBridgeOverrides['hostMetrics']>;
  fileRead: NonNullable<FakeBridgeOverrides['fileRead']>;
  fileWrite: NonNullable<FakeBridgeOverrides['fileWrite']>;
  fileAtomicWrite: NonNullable<FakeBridgeOverrides['fileAtomicWrite']>;
  containerInspect: NonNullable<FakeBridgeOverrides['containerInspect']>;
  containerRun: NonNullable<FakeBridgeOverrides['containerRun']>;
  containerStart: NonNullable<FakeBridgeOverrides['containerStart']>;
  containerStop: NonNullable<FakeBridgeOverrides['containerStop']>;
  containerRm: NonNullable<FakeBridgeOverrides['containerRm']>;
  containerLogsFollow: NonNullable<FakeBridgeOverrides['containerLogsFollow']>;
  depotUpdate: NonNullable<FakeBridgeOverrides['depotUpdate']>;
  ufwRule: NonNullable<FakeBridgeOverrides['ufwRule']>;
  processInfo: NonNullable<FakeBridgeOverrides['processInfo']>;
  close(): Promise<void>;
  files: Map<string, Buffer>;
}

export function makeFakeBridge(overrides: FakeBridgeOverrides = {}): FakeBridge {
  const files = new Map<string, Buffer>();
  return {
    ping:
      overrides.ping ??
      (async () => ({ version: 'test', hostname: 'test-host', uptime_seconds: 1 })),
    hostInfo:
      overrides.hostInfo ??
      (async () => ({ os_name: 'Ubuntu', os_version: '24.04', kernel: '6.8', uptime_seconds: 42 })),
    hostMetrics:
      overrides.hostMetrics ??
      (async () => ({
        cpu_percent: 1,
        mem_used: 100,
        mem_total: 1000,
        disk_used: 10,
        disk_total: 100,
      })),
    fileRead:
      overrides.fileRead ??
      (async (p: string) => {
        const buf = files.get(p);
        if (!buf) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return buf;
      }),
    fileWrite:
      overrides.fileWrite ??
      (async (p: string, data: Buffer) => {
        files.set(p, Buffer.from(data));
      }),
    fileAtomicWrite:
      overrides.fileAtomicWrite ??
      (async (p: string, data: Buffer) => {
        files.set(p, Buffer.from(data));
      }),
    containerInspect:
      overrides.containerInspect ??
      (async () => ({ State: { Status: 'running', Running: true }, Config: {}, Id: 'fake' })),
    containerRun: overrides.containerRun ?? (async () => ({ container_id: 'fake-container-id' })),
    containerStart: overrides.containerStart ?? (async () => undefined),
    containerStop: overrides.containerStop ?? (async () => undefined),
    containerRm: overrides.containerRm ?? (async () => undefined),
    containerLogsFollow: overrides.containerLogsFollow ?? (() => ({ close() {} })),
    depotUpdate: overrides.depotUpdate ?? (() => ({ close() {}, done: Promise.resolve(0) })),
    ufwRule: overrides.ufwRule ?? (async () => undefined),
    processInfo: overrides.processInfo ?? (async (pid: number) => ({ pid, alive: true })),
    async close() {},
    files,
  };
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
  /** Whether to seed an organization + system roles + owner user. */
  seedOwner?: { email: string; password: string; displayName?: string };
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
    orgId?: string;
    ownerUserId?: string;
    ownerEmail?: string;
    ownerPassword?: string;
  };
}

export async function buildIntegrationApp(opts: BuildAppOptions = {}): Promise<IntegrationHarness> {
  const schemaInfo = await createIsolatedSchema();
  await runMigrations(schemaInfo.url);

  const db = createDatabaseClient(schemaInfo.url);
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

  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(hostRoutes);
  await app.register(serverRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverLogsRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(auditRoutes);

  const seed: IntegrationHarness['seed'] = {};
  if (opts.seedOwner) {
    const orgId = uuidv7();
    await db.insert((await import('@squad/db/schema')).organizations).values({
      id: orgId,
      name: 'Test Org',
      slug: 'test-org',
    });
    await seedSystemRoles(db, orgId);
    const ownerUserId = uuidv7();
    const passwordHash = await hashPassword(opts.seedOwner.password);
    await db.insert(users).values({
      id: ownerUserId,
      email: opts.seedOwner.email.toLowerCase(),
      passwordHash,
      displayName: opts.seedOwner.displayName ?? 'Test Owner',
    });
    const ownerRole = await db.query.roles.findFirst({
      where: (r, { and: _a, eq: _e }) => _a(_e(r.orgId, orgId), _e(r.name, 'Owner' as RoleName)),
    });
    if (ownerRole) {
      await db
        .insert((await import('@squad/db/schema')).userRoleAssignments)
        .values({ userId: ownerUserId, roleId: ownerRole.id });
      await db
        .insert((await import('@squad/db/schema')).organizationMembers)
        .values({ userId: ownerUserId, orgId, primaryRoleId: ownerRole.id });
    }
    seed.orgId = orgId;
    seed.ownerUserId = ownerUserId;
    seed.ownerEmail = opts.seedOwner.email;
    seed.ownerPassword = opts.seedOwner.password;
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
      await schemaInfo.drop().catch(() => undefined);
    },
  };
}

/**
 * Log in the seeded owner; returns a Cookie header string ready for subsequent
 * `inject()` calls.
 */
export async function loginAsOwner(h: IntegrationHarness): Promise<string> {
  if (!h.seed.ownerEmail || !h.seed.ownerPassword) {
    throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
  }
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: h.seed.ownerEmail, password: h.seed.ownerPassword },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`login failed: ${resp.statusCode} ${resp.body}`);
  }
  const setCookie = resp.headers['set-cookie'];
  if (!setCookie) throw new Error('login did not return a cookie');
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  const match = raw.match(/(__Host-sid=[^;]+)/);
  if (!match) throw new Error('cookie header did not contain __Host-sid');
  return match[1]!;
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
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `expected audit row with action=${expected.action} resource=${expected.resource ?? 'any'} within ${withinMs}ms; none found after polling`,
  );
}
