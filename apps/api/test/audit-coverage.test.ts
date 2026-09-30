/**
 * CI guard for TZ §17.12: every mutating route (POST/PUT/PATCH/DELETE)
 * must declare config.audit — either an {action, resource} object that
 * plugins/audit.ts persists, `'manual'` for a handler that writes its own
 * audit_log rows (checked below: its module must call writeAuditEntry), or
 * the explicit `false` for the short allowlist of machine-integration
 * endpoints that are deliberately unaudited. A frozen legacy list of routes
 * that predate this guard is also tolerated (see LEGACY_SELF_AUDITED).
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

/**
 * Mutating routes that predate this guard covering every module (the guard
 * used to register a hand-picked list of route files) and that write their
 * own audit entries in the handler instead of declaring `config.audit`.
 * Frozen: the list may only shrink. Move a route to a declarative
 * `config.audit` (with `req.auditSnapshots` for before/after) and delete its
 * line here; the last test fails when an entry goes stale.
 */
const LEGACY_SELF_AUDITED = new Set<string>([
  'PUT /api/v1/servers/:id/seeding-settings',
  'POST /api/v1/servers/:id/seed-schedule',
  'PATCH /api/v1/servers/:id/seed-schedule/:entryId',
  'DELETE /api/v1/servers/:id/seed-schedule/:entryId',
  'POST /api/v1/servers/:id/scheduled-tasks',
  'PATCH /api/v1/servers/:id/scheduled-tasks/:taskId',
  'DELETE /api/v1/servers/:id/scheduled-tasks/:taskId',
  'PUT /api/v1/servers/:id/seed-subscription',
  'POST /api/v1/servers/:id/seed-call',
  'POST /api/v1/servers/:serverId/map/next',
  'POST /api/v1/servers/:serverId/map/change',
  'POST /api/v1/servers/:serverId/map/end-match',
  'PUT /api/v1/servers/:serverId/map-vote/settings',
  'PUT /api/v1/servers/:serverId/map-vote/candidates',
  'POST /api/v1/servers/:serverId/map-vote/versions/:versionId/restore',
  'POST /api/v1/servers/:serverId/broadcast',
  'POST /api/v1/servers/:serverId/squads/:squadId/message',
  'POST /api/v1/servers/:serverId/players/:playerId/message',
  'PUT /api/v1/servers/:id/rotation',
  'POST /api/v1/servers/:id/rotation-schedule',
  'PATCH /api/v1/servers/:id/rotation-schedule/:entryId',
  'DELETE /api/v1/servers/:id/rotation-schedule/:entryId',
  'PUT /api/v1/servers/:id/rotation-profiles',
  'POST /api/v1/players/:playerId/marks',
  'DELETE /api/v1/players/:playerId/marks/:markId',
  'POST /api/v1/mark-types',
  'PATCH /api/v1/mark-types/:id',
  'PATCH /api/v1/mark-types/reorder',
  'POST /api/v1/players/:playerId/links',
  'PATCH /api/v1/player-links/:linkId',
  'PATCH /api/v1/appeals/:id',
  'POST /api/v1/moderation-actions/bulk',
  'POST /api/v1/players/:playerId/bonus-adjustments',
  'POST /api/v1/media',
  'POST /api/v1/media/link',
  'DELETE /api/v1/media/:id',
  'POST /api/v1/media/:id/links',
  'DELETE /api/v1/media/:id/links',
  'POST /api/v1/media/:id/publications',
  'DELETE /api/v1/media/:id/publications/:destination',
  'PATCH /api/v1/integrations/media-publishing',
  'POST /api/v1/media/upload-tokens',
  'PUT /api/v1/settings/economy',
  'POST /api/v1/settings/chat-flag-rules',
  'PATCH /api/v1/settings/chat-flag-rules/:id',
  'DELETE /api/v1/settings/chat-flag-rules/:id',
  'POST /api/v1/settings/chat-flag-rules/reindex',
  'PATCH /api/v1/settings/clan-guard',
  'PUT /api/v1/settings/alt-detection',
  'POST /api/v1/settings/alt-detection/ignored-ips',
  'DELETE /api/v1/settings/alt-detection/ignored-ips/:id',
  'PUT /api/v1/settings/banlist-publication',
  'PUT /api/v1/settings/coplay',
  'POST /api/v1/clans',
  'PATCH /api/v1/clans/:id',
  'PATCH /api/v1/clans/:id/settings',
  'PATCH /api/v1/clans/:id/expire',
  'DELETE /api/v1/clans/:id',
  'POST /api/v1/clans/:id/members',
  'PATCH /api/v1/clans/:id/members/:playerId',
  'DELETE /api/v1/clans/:id/members/:playerId',
  'PUT /api/v1/clans/:id/members/:playerId/priority',
  'POST /api/v1/clans/:id/transfer-leadership',
  'PUT /api/v1/vehicle-catalog/:assetId',
  'POST /api/v1/vip-tiers',
  'PUT /api/v1/vip-tiers/:id',
  'DELETE /api/v1/vip-tiers/:id',
  'POST /api/v1/reports',
  'PATCH /api/v1/reports/:id',
  'POST /api/v1/reports/:id/actions',
  'POST /api/v1/reports/:id/notify-reporter',
  'POST /api/v1/reports/bulk-resolve',
  'POST /api/v1/players/:playerId/notes',
  'PATCH /api/v1/notes/:noteId',
  'DELETE /api/v1/notes/:noteId',
  'POST /api/v1/players/:playerId/external-bans/:externalBanId/local-ban',
  'POST /api/v1/integrations/discord/interactions',
  'POST /api/v1/public/appeals',
  'POST /api/v1/public/media',
  'PUT /api/v1/whitelist/settings',
  'POST /api/v1/whitelist/members',
  'DELETE /api/v1/whitelist/members/:playerId',
  'POST /api/v1/whitelist/import',
  'POST /api/v1/public/whitelist/applications',
  'PUT /api/v1/whitelist/applications/settings',
  'PATCH /api/v1/whitelist/applications/:id',
]);

/** Machine-to-machine endpoints that answer before any panel state changes. */
const MACHINE_INTEGRATION_EXCEPTIONS = new Set(['POST /api/v1/integrations/balancer/proposals']);

const routeKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;

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

/**
 * A chainable, awaitable no-op standing in for `app.db`: route modules that
 * seed rows while registering (issues.ts → `ensureSystemIssueLabels`) resolve
 * every query chain to an empty result instead of needing a live database.
 */
function inertDb(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, prop) =>
      prop === 'then' ? (resolve: (value: unknown[]) => void) => resolve([]) : inertDb(),
    apply: () => inertDb(),
  });
}

async function collectRoutes(): Promise<RouteRecord[]> {
  const rows: RouteRecord[] = [];
  for (const file of registeredRouteFiles()) {
    const app: FastifyInstance = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', inertDb() as never);
    for (const name of [
      'redis',
      'bridge',
      'liveBus',
      'config',
      'encryptionKey',
      'diag',
      'makeBridgeClient',
      'installProgress',
      'statusReconciler',
    ]) {
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

  it('mutating-verb routes with audit: false are limited to explicit machine-integration exceptions', async () => {
    const routes = await routesPromise;
    const falsy = routes.filter(
      (r) =>
        MUTATING.has(r.method) && !r.url.startsWith(SWAGGER_PREFIX) && r.config.audit === false,
    );
    for (const r of falsy) {
      const key = routeKey(r);
      expect(
        MACHINE_INTEGRATION_EXCEPTIONS.has(key) || LEGACY_SELF_AUDITED.has(key),
        `unexpected audit:false on ${key} — declare config.audit: { action, resource }`,
      ).toBe(true);
    }
  });

  // Audit #102/#116: ban-sources and banned-names used `audit: false` with a
  // hand-written audit entry on the success path only, and escaped this guard
  // because their modules were not in its registration list.
  it.each([
    'POST /api/v1/ban-sources',
    'PUT /api/v1/ban-sources/:id',
    'DELETE /api/v1/ban-sources/:id',
    'POST /api/v1/ban-sources/:id/sync',
    'POST /api/v1/banned-names',
    'PATCH /api/v1/banned-names/:id',
    'DELETE /api/v1/banned-names/:id',
  ])('%s declares a declarative config.audit', async (key) => {
    const routes = await routesPromise;
    const route = routes.find((r) => routeKey(r) === key);
    expect(route, `${key} is not registered`).toBeDefined();
    expect(route?.config.audit).toMatchObject({
      action: expect.any(String),
      resource: expect.any(String),
    });
  });

  it('the legacy exception list only names routes that still need it', async () => {
    const routes = await routesPromise;
    const byKey = new Map(routes.map((r) => [routeKey(r), r]));
    for (const key of LEGACY_SELF_AUDITED) {
      const audit = byKey.get(key)?.config.audit;
      expect(audit === false || audit === 'manual', `stale LEGACY_SELF_AUDITED entry ${key}`).toBe(
        true,
      );
    }
  });

  it("every audit: 'manual' route lives in a module that writes audit_log itself", async () => {
    const manualFiles = new Set(
      mutatingRoutes(await routesPromise)
        .filter((r) => r.config.audit === 'manual')
        .map((r) => r.file),
    );
    const silent = [...manualFiles].filter((file) => {
      const source = readFileSync(path.join(routesDir, file), 'utf8');
      // The map and messaging modules share auditMapLikeAction (lib/map-guards.ts),
      // which is the writeAuditEntry call site for those routes.
      return !source.includes('writeAuditEntry(') && !source.includes('auditMapLikeAction(');
    });
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
