/**
 * CI guard for TZ §17.12: every mutating route (POST/PUT/PATCH/DELETE)
 * must declare config.audit — either an {action, resource} object that
 * plugins/audit.ts persists, `'manual'` for a handler that writes its own
 * audit_log rows (checked below: its module must call writeAuditEntry), or
 * the explicit `false` for the short allowlist of machine-integration
 * endpoints that are deliberately unaudited.
 *
 * The route table comes from `registerRoutes()` — the single registration
 * list `server.ts` and the integration harness use — one route module at a
 * time, so every route is attributed to its source file. Nothing needs a live
 * DB/Redis/bridge: the decorations routes touch at registration are inert.
 * Paths under /api/docs (Swagger static UI) are excluded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SWAGGER_PREFIX = '/api/docs';

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(here, '..', 'src', 'routes');

/** Mutating routes deliberately left unaudited, each with the reason. */
const UNAUDITED_MUTATING_ROUTES = new Map<string, string>([
  [
    'POST /api/v1/integrations/balancer/proposals',
    'HMAC-authenticated machine ingestion; proposals are stored, never executed',
  ],
]);

interface RouteRecord {
  method: string;
  url: string;
  config: Record<string, unknown>;
  /** Route module file name under src/routes/. */
  file: string;
}

/** Route module file names in `registerRoutes()` order, read from routes/index.ts. */
function registeredRouteFiles(): string[] {
  const source = readFileSync(path.join(routesDir, 'index.ts'), 'utf8');
  const identToFile = new Map<string, string>();
  for (const match of source.matchAll(/^import (\w+) from '\.\/([\w-]+)\.js';$/gm)) {
    if (match[1] && match[2]) identToFile.set(match[1], `${match[2]}.ts`);
  }
  const files: string[] = [];
  for (const match of source.matchAll(/await app\.register\((\w+)\);/g)) {
    const file = match[1] ? identToFile.get(match[1]) : undefined;
    if (file) files.push(file);
  }
  return files;
}

/** A stand-in for every decoration: any property read or call yields itself. */
const inert: object = new Proxy(() => undefined, {
  get: (_target, prop) => (prop === 'then' ? undefined : inert),
  apply: () => inert,
});

async function collectRoutes(): Promise<RouteRecord[]> {
  const rows: RouteRecord[] = [];
  for (const file of registeredRouteFiles()) {
    const app: FastifyInstance = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    for (const name of ['db', 'redis', 'bridge', 'liveBus', 'config', 'encryptionKey', 'diag']) {
      app.decorate(name, inert);
    }
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) {
        rows.push({
          method: String(m).toUpperCase(),
          url: route.url,
          config: (route.config ?? {}) as Record<string, unknown>,
          file,
        });
      }
    });
    const mod = (await import(/* @vite-ignore */ path.join(routesDir, file))) as {
      default: FastifyPluginAsync;
    };
    await app.register(mod.default);
    await app.ready();
    await app.close();
  }
  return rows;
}

const routesPromise = collectRoutes();

function mutatingRoutes(routes: RouteRecord[]): RouteRecord[] {
  return routes.filter((r) => MUTATING.has(r.method) && !r.url.startsWith(SWAGGER_PREFIX));
}

describe('audit coverage (TZ §17.12 CI guard)', () => {
  it('collects the full registerRoutes() table, not a hand-picked subset', async () => {
    const routes = await routesPromise;
    expect(new Set(routes.map((r) => r.file)).size).toBe(registeredRouteFiles().length);
    expect(registeredRouteFiles().length).toBeGreaterThan(100);
  });

  it('every mutating route declares config.audit', async () => {
    const mutating = mutatingRoutes(await routesPromise);
    expect(mutating.length).toBeGreaterThan(0);

    const missing = mutating.filter((r) => !Object.hasOwn(r.config, 'audit'));
    if (missing.length > 0) {
      const lines = missing.map((r) => `  ${r.method} ${r.url} (${r.file})`).join('\n');
      throw new Error(
        `Routes missing config.audit (add { action, resource }, 'manual' or, allowlisted, false):\n${lines}`,
      );
    }
  });

  it('mutating routes with audit: false are limited to the allowlisted machine integrations', async () => {
    const unaudited = mutatingRoutes(await routesPromise)
      .filter((r) => r.config.audit === false)
      .map((r) => `${r.method} ${r.url}`);
    expect(unaudited.sort()).toEqual([...UNAUDITED_MUTATING_ROUTES.keys()].sort());
  });

  it("every audit: 'manual' route lives in a module that writes audit_log itself", async () => {
    const manualFiles = new Set(
      mutatingRoutes(await routesPromise)
        .filter((r) => r.config.audit === 'manual')
        .map((r) => r.file),
    );
    const silent = [...manualFiles].filter(
      (file) => !readFileSync(path.join(routesDir, file), 'utf8').includes('writeAuditEntry('),
    );
    expect(silent, "modules declaring audit: 'manual' without a writeAuditEntry call").toEqual([]);
  });

  it('every status-flipping route emits a server.* diag event in its handler source', async () => {
    const STATUS_FLIPPING_ROUTES = new Map<string, string>([
      ['POST /api/v1/servers/:id/start', 'servers.ts'],
      ['POST /api/v1/servers/:id/stop', 'servers.ts'],
      ['POST /api/v1/servers/:id/install', 'server-install.ts'],
      ['DELETE /api/v1/servers/:id', 'servers.ts'],
      ['POST /api/v1/servers/archive/:id/restore', 'server-archive.ts'],
    ]);

    const routes = await routesPromise;
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
