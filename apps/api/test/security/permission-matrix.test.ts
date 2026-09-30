import * as schema from '@squad/db/schema';
import { playerApiTokens } from '@squad/db/schema';
import { PERMISSIONS, type PermissionKey } from '@squad/shared-config';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { InjectOptions } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintApiToken } from '../../src/lib/api-tokens.js';
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

async function collectProtectedRoutes(): Promise<{ routes: RouteSpec[]; wsRoutes: RouteSpec[] }> {
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
  const { default: serverUpdateRoutes } = await import('../../src/routes/server-update.js');
  const { default: depotRoutes } = await import('../../src/routes/depot.js');
  const { default: playerRoutes } = await import('../../src/routes/players.js');
  const { default: auditRoutes } = await import('../../src/routes/audit.js');
  const { default: logsRoutes } = await import('../../src/routes/logs.js');
  const { default: adminsCfgRoutes } = await import('../../src/routes/admins-cfg.js');
  const { default: liveRoutes } = await import('../../src/routes/live.js');
  const { default: serverLogsRoutes } = await import('../../src/routes/server-logs.js');

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
  // biome-ignore lint/suspicious/noExplicitAny: test fixture — live.ts calls app.liveBus.subscribe(...) at plugin registration time
  (app as any).decorate('liveBus', { subscribe: () => () => undefined });
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).setErrorHandler(() => undefined);

  const result: RouteSpec[] = [];
  const wsRoutesSeen: RouteSpec[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const required = (route.config as Record<string, unknown>)?.permissions as string[] | undefined;
    if (!required || required.length === 0) return;
    if ((route as unknown as Record<string, unknown>).websocket === true) {
      for (const m of methods) {
        // Fastify's default exposeHeadRoutes mirrors every GET registration with a
        // synthetic HEAD route; a WS upgrade only ever happens over GET, so the
        // auto-generated HEAD duplicate is not a real websocket route to track.
        if (String(m).toUpperCase() === 'HEAD') continue;
        wsRoutesSeen.push({ method: String(m).toUpperCase(), url: route.url, required });
      }
      return;
    }
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
  await app.register(serverUpdateRoutes);
  await app.register(depotRoutes);
  await app.register(playerRoutes);
  await app.register(auditRoutes);
  await app.register(logsRoutes);
  await app.register(adminsCfgRoutes);
  await app.register(liveRoutes);
  await app.register(serverLogsRoutes);

  await app.ready();
  await app.close();
  return { routes: result, wsRoutes: wsRoutesSeen };
}

function canonicalUrl(url: string): string {
  return url.replace(/:([a-zA-Z_]+)/g, (_m, name: string) => {
    if (name === 'id') return '00000000-0000-0000-0000-000000000001';
    if (name === 'playerId') return '00000000-0000-0000-0000-000000000002';
    if (name === 'filename') return 'Server.cfg';
    if (name === 'versionId') return '00000000-0000-0000-0000-000000000001';
    return 'placeholder';
  });
}

const ALL_PERM_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

const { routes: protectedRoutes, wsRoutes } = await collectProtectedRoutes();

describe('permission matrix coverage', () => {
  it('includes Admins.cfg drift and force-sync routes', () => {
    expect(protectedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/admins-cfg/drift',
          required: ['admin_group:view'],
        }),
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/admins-cfg/drift/all',
          required: ['admin_group:view'],
        }),
        expect.objectContaining({
          method: 'POST',
          url: '/api/v1/admins-cfg/sync',
          required: ['admin_group:edit'],
        }),
      ]),
    );
  });

  it('sweeps POST /api/v1/servers/:id/update — server-update.ts was previously missing from collectProtectedRoutes() (#271)', () => {
    expect(protectedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          url: '/api/v1/servers/:id/update',
          required: ['server:update'],
        }),
      ]),
    );
  });

  it('tracks exactly the four currently-permissioned websocket routes (#250) — update deliberately if this list changes', () => {
    const sorted = wsRoutes
      .slice()
      .sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
    expect(sorted).toEqual([
      { method: 'GET', url: '/api/v1/depot/progress/ws', required: ['server:view'] },
      { method: 'GET', url: '/api/v1/servers/:id/install/ws', required: ['server:view'] },
      { method: 'GET', url: '/api/v1/servers/:id/logs/ws', required: ['server:download_logs'] },
      { method: 'GET', url: '/api/v1/ws/live', required: ['server:view'] },
    ]);
  });
});

let h: IntegrationHarness;
let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Request headers that authenticate each matrix user (session cookie or API token). */
const authHeaders = new Map<string, Record<string, string>>();
/**
 * Holds exactly `perms`: an API token of the all-powerful seeded Owner narrowed
 * to `perms` (`role ∩ scopes`, `narrowToTokenScopes`). A session-based user
 * cannot do this: a role without `panel_access` is dropped to anonymous (#33)
 * and, with `panel_access`, derives far more than the set; flag-gated keys
 * additionally need role flags that the DB ties to `panel_access` (#36).
 */
async function createTokenUserWithPerms(key: string, perms: string[]): Promise<void> {
  const ownerPlayerId = h.seed.ownerPlayerId;
  if (!ownerPlayerId) throw new Error('matrix needs the seeded owner');
  const minted = mintApiToken();
  await db.insert(playerApiTokens).values({
    id: minted.id,
    playerId: ownerPlayerId,
    name: `matrix-${key}`,
    tokenHash: minted.tokenHash,
    scopes: perms,
  });
  authHeaders.set(key, { authorization: `Bearer ${minted.plaintext}` });
}

async function inject(
  method: string,
  url: string,
  cookieKey: string,
): Promise<{ statusCode: number }> {
  const headers = authHeaders.get(cookieKey);
  if (!headers) throw new Error(`no credentials for key "${cookieKey}"`);
  // Methods come from the registered route table, so they are valid HTTP methods.
  return h.app.inject({ method: method as InjectOptions['method'], url, headers });
}

describe('permission matrix', () => {
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

    await Promise.all(tasks.map(([key, perms]) => createTokenUserWithPerms(key, perms)));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await h.cleanup();
  }, 60_000);

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
