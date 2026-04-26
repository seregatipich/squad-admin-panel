import * as schema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { PERMISSIONS, type PermissionKey } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(700001);

interface RouteSpec {
  method: string;
  url: string;
  required: string[];
}

async function collectProtectedRoutes(): Promise<RouteSpec[]> {
  const Fastify = (await import('fastify')).default;
  const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
  const { default: authRoutes } = await import('../../src/routes/auth.js');
  const { default: meTokensRoutes } = await import('../../src/routes/me-tokens.js');
  const { default: permissionsRoutes } = await import('../../src/routes/permissions.js');
  const { default: rolesRoutes } = await import('../../src/routes/roles.js');
  const { default: usersRoutes } = await import('../../src/routes/users.js');
  const { default: hostRoutes } = await import('../../src/routes/host.js');
  const { default: hostActionsRoutes } = await import('../../src/routes/host-actions.js');
  const { default: serverRoutes } = await import('../../src/routes/servers.js');
  const { default: serverInstallRoutes } = await import('../../src/routes/server-install.js');
  const { default: serverConfigRoutes } = await import('../../src/routes/server-configs.js');
  const { default: depotRoutes } = await import('../../src/routes/depot.js');
  const { default: playerRoutes } = await import('../../src/routes/players.js');
  const { default: auditRoutes } = await import('../../src/routes/audit.js');
  const { default: logsRoutes } = await import('../../src/routes/logs.js');

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('encryptionKey', Buffer.alloc(32));
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).setErrorHandler(() => undefined);

  const result: RouteSpec[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const required = (route.config as Record<string, unknown>)?.permissions as string[] | undefined;
    if (!required || required.length === 0) return;
    if (route.url.startsWith('/api/docs')) return;
    if ((route as unknown as Record<string, unknown>).websocket === true) return;
    for (const m of methods) {
      result.push({ method: String(m).toUpperCase(), url: route.url, required });
    }
  });

  await app.register(authRoutes);
  await app.register(meTokensRoutes);
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(usersRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(serverInstallRoutes);
  await app.register(serverConfigRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);

  await app.ready();
  await app.close();
  return result;
}

function canonicalUrl(url: string): string {
  return url.replace(/:([a-zA-Z_]+)/g, (_m, name: string) => {
    if (name === 'id') return '00000000-0000-0000-0000-000000000001';
    if (name === 'steamId') return '76561198000000001';
    if (name === 'filename') return 'Server.cfg';
    if (name === 'versionId') return '00000000-0000-0000-0000-000000000001';
    return 'placeholder';
  });
}

const ALL_PERM_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

const protectedRoutes = await collectProtectedRoutes();

let h: IntegrationHarness;
let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const createdRoleIds: string[] = [];
const cookies = new Map<string, string>();
const userKeys = new Map<string, bigint>();
let steamCounter = 700100;

async function createUserWithPerms(key: string, perms: string[]): Promise<void> {
  const steamId = testSteamId(steamCounter++);
  userKeys.set(key, steamId);

  const roleId = uuidv7();
  createdRoleIds.push(roleId);

  await db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `mx-${roleId}`,
      color: 'neutral',
      isSystemRole: false,
    });
    if (perms.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(perms.map((permissionKey) => ({ roleId, permissionKey })));
    }
    const stub = `Mx${String(steamId).slice(-6)}`;
    await tx
      .insert(players)
      .values({
        steamId64: steamId,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
        roleId,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId } });
  });

  invalidatePermissionCache(steamId);
  const { token } = await createSession(h.db, h.redis, {
    steamId64: steamId,
    ip: null,
    userAgent: 'matrix-test',
    ttlMs: 21_600_000,
  });
  cookies.set(key, `__Host-sid=${token}`);
}

async function inject(
  method: string,
  url: string,
  cookieKey: string,
): Promise<{ statusCode: number }> {
  const cookie = cookies.get(cookieKey);
  if (!cookie) throw new Error(`no cookie for key "${cookieKey}"`);
  return h.app.inject({ method, url, headers: { cookie } });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  sql = postgres(h.url, { max: 10, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>;

  const uniqueRequiredSets = new Set(
    protectedRoutes.map((r) => r.required.slice().sort().join(',')),
  );

  const tasks: Array<[string, string[]]> = [
    ['noPerms', []],
    ...ALL_PERM_KEYS.map((perm): [string, string[]] => [perm, [perm]]),
    ...[...uniqueRequiredSets].map((setKey): [string, string[]] => [
      `full:${setKey}`,
      setKey.split(',').filter(Boolean),
    ]),
  ];

  await Promise.all(tasks.map(([key, perms]) => createUserWithPerms(key, perms)));
});

afterAll(async () => {
  for (const id of createdRoleIds) {
    await db
      .delete(rolePermissions)
      .where(eq(rolePermissions.roleId, id))
      .catch(() => undefined);
    await db
      .delete(roles)
      .where(eq(roles.id, id))
      .catch(() => undefined);
  }
  for (const steamId of userKeys.values()) {
    await db
      .update(players)
      .set({ roleId: null })
      .where(eq(players.steamId64, steamId))
      .catch(() => undefined);
    invalidatePermissionCache(steamId);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  await h.cleanup();
}, 60_000);

describe('permission matrix', () => {
  for (const route of protectedRoutes) {
    const { method, url, required } = route;
    const targetUrl = canonicalUrl(url);
    const label = `${method} ${url}`;
    const fullKey = `full:${required.slice().sort().join(',')}`;

    describe(label, () => {
      it('returns 403 to a user with no permissions', async () => {
        const res = await inject(method, targetUrl, 'noPerms');
        expect(res.statusCode).toBe(403);
      });

      it('returns not-403 to a user with all required permissions', async () => {
        const res = await inject(method, targetUrl, fullKey);
        expect(res.statusCode).not.toBe(403);
      });

      for (const perm of ALL_PERM_KEYS) {
        const isExact = required.length === 1 && required[0] === perm;
        const isPartialMatch = required.includes(perm) && required.length > 1;

        it(`with only ${perm}: ${isExact ? 'allowed' : '403'}`, async () => {
          const res = await inject(method, targetUrl, perm);
          if (isExact) {
            expect(res.statusCode).not.toBe(403);
          } else if (isPartialMatch) {
            expect(res.statusCode).toBe(403);
          } else {
            expect(res.statusCode).toBe(403);
          }
        });
      }
    });
  }
});
