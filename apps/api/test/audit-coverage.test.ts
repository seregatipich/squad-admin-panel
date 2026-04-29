/**
 * CI guard for TZ §17.12: every mutating route (POST/PUT/PATCH/DELETE)
 * must declare config.audit — either an {action, resource} object that
 * plugins/audit.ts will persist, or the explicit `false` for routes that
 * only affect client-local state (e.g. /auth/logout on an already-dead
 * session).
 *
 * The check is static on the registered route table; it does not
 * require the compose stack to be up. Paths under /api/docs (Swagger
 * static UI) are excluded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';

import authPlugin from '../src/plugins/auth.js';
import bridgePlugin from '../src/plugins/bridge.js';
import databasePlugin from '../src/plugins/database.js';
import installProgressPlugin from '../src/plugins/install-progress.js';
import redisPlugin from '../src/plugins/redis.js';
import requestContextPlugin from '../src/plugins/request-context.js';

import adminsCfgRoutes from '../src/routes/admins-cfg.js';
import auditRoutes from '../src/routes/audit.js';
import authRoutes from '../src/routes/auth.js';
import steamRoutes from '../src/routes/auth-steam.js';
import hostRoutes from '../src/routes/host.js';
import hostActionsRoutes from '../src/routes/host-actions.js';
import meTokensRoutes from '../src/routes/me-tokens.js';
import permissionsRoutes from '../src/routes/permissions.js';
import playerRoutes from '../src/routes/players.js';
import roleMembersRoutes from '../src/routes/role-members.js';
import rolesRoutes from '../src/routes/roles.js';
import archiveRoutes from '../src/routes/server-archive.js';
import serverInstallRoutes from '../src/routes/server-install.js';
import serverRoutes from '../src/routes/servers.js';
import usersRoutes from '../src/routes/users.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SWAGGER_PREFIX = '/api/docs';

interface RouteRecord {
  method: string;
  url: string;
  config: Record<string, unknown>;
}

async function collectRoutes(): Promise<RouteRecord[]> {
  const app: FastifyInstance = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Minimal stubs for the plugin decorations that routes read from. We
  // don't need real DB/Redis/Bridge to enumerate routes.
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('db', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', {});
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('encryptionKey', Buffer.alloc(32));

  const rows: RouteRecord[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      rows.push({
        method: String(m).toUpperCase(),
        url: route.url,
        config: (route.config ?? {}) as Record<string, unknown>,
      });
    }
  });

  // We intentionally DO NOT register auth/audit/install-progress plugins
  // here — they run logic that would need live DB/Redis. Route records
  // still pick up config.audit because it is declared on the route
  // itself, not injected by plugins.
  // Register all route modules; skip deps they would use at runtime.
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).setErrorHandler(() => undefined);

  await app.register(authRoutes);
  await app.register(meTokensRoutes);
  await app.register(hostRoutes);
  await app.register(hostActionsRoutes);
  await app.register(serverRoutes);
  await app.register(archiveRoutes);
  await app.register(serverInstallRoutes);
  await app.register(permissionsRoutes);
  await app.register(rolesRoutes);
  await app.register(roleMembersRoutes);
  await app.register(usersRoutes);
  await app.register(playerRoutes);
  await app.register(adminsCfgRoutes);
  await app.register(auditRoutes);
  await app.register(steamRoutes);

  // suppress 'unused imports' — plugins are referenced here defensively
  // so a future refactor that pulls them into the route registration
  // doesn't flap this test.
  void authPlugin;
  void bridgePlugin;
  void databasePlugin;
  void installProgressPlugin;
  void redisPlugin;
  void requestContextPlugin;

  await app.ready();
  await app.close();
  return rows;
}

describe('audit coverage (TZ §17.12 CI guard)', () => {
  it('every mutating route declares config.audit (either an object or explicit false)', async () => {
    const routes = await collectRoutes();
    const mutating = routes.filter(
      (r) => MUTATING.has(r.method) && !r.url.startsWith(SWAGGER_PREFIX),
    );
    expect(mutating.length).toBeGreaterThan(0);

    const missing = mutating.filter((r) => !Object.hasOwn(r.config, 'audit'));
    if (missing.length > 0) {
      const lines = missing.map((r) => `  ${r.method} ${r.url}`).join('\n');
      throw new Error(
        `Routes missing config.audit (add { audit: { action, resource } } or { audit: false }):\n${lines}`,
      );
    }
  });

  it('mutating routes that claim audit: false are limited to auth callbacks and OAuth entry points', async () => {
    const routes = await collectRoutes();
    const allowlist = new Set(['/api/v1/auth/steam/callback']);
    const falsy = routes.filter(
      (r) =>
        MUTATING.has(r.method) && !r.url.startsWith(SWAGGER_PREFIX) && r.config.audit === false,
    );
    for (const r of falsy) {
      expect(allowlist.has(r.url), `unexpected audit:false on ${r.method} ${r.url}`).toBe(true);
    }
  });

  it('every status-flipping route emits a server.* diag event in its handler source', async () => {
    const STATUS_FLIPPING_ROUTES = new Map<string, string>([
      ['POST /api/v1/servers/:id/start', 'servers.ts'],
      ['POST /api/v1/servers/:id/stop', 'servers.ts'],
      ['POST /api/v1/servers/:id/install', 'server-install.ts'],
      ['DELETE /api/v1/servers/:id', 'servers.ts'],
      ['POST /api/v1/servers/archive/:id/restore', 'server-archive.ts'],
    ]);

    const routes = await collectRoutes();
    const seen = new Set<string>();
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (STATUS_FLIPPING_ROUTES.has(key)) seen.add(key);
    }
    for (const key of STATUS_FLIPPING_ROUTES.keys()) {
      expect(
        seen.has(key),
        `status-flipping route ${key} is not registered — STATUS_FLIPPING_ROUTES is stale`,
      ).toBe(true);
    }

    const here = path.dirname(fileURLToPath(import.meta.url));
    const routesDir = path.resolve(here, '..', 'src', 'routes');
    // Tolerate single/double quotes and arbitrary whitespace + newlines between
    // diag.emit( and the kind: 'server.<x>' literal. Matches both
    // `req.diag.emit({ ... kind: 'server.foo' ... })` and the
    // `app.diag.emit(...)` / `emitCtx.diag.emit(...)` variants used in
    // server-install.ts.
    const DIAG_EMIT_SERVER_RE = /diag\.emit\(\s*\{[\s\S]*?kind:\s*['"]server\.[a-z_.]+['"]/m;

    for (const [key, file] of STATUS_FLIPPING_ROUTES) {
      const handlerFile = path.join(routesDir, file);
      const source = readFileSync(handlerFile, 'utf8');
      if (!DIAG_EMIT_SERVER_RE.test(source)) {
        throw new Error(
          `route ${key} flips server.status but does not emit a server.* diag event in ${handlerFile}`,
        );
      }
    }
  });
});
