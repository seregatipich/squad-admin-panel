/**
 * CI guard for TZ §17.12: every mutating route (POST/PUT/PATCH/DELETE)
 * must declare config.audit as an {action, resource} object that
 * plugins/audit.ts persists for every outcome, denied attempts included.
 * `audit: false` is limited to machine-integration endpoints and to the
 * frozen legacy list of self-audited routes below.
 *
 * The check is static on the route table `registerRoutes()` builds — the
 * same one the server serves — so it does not require the compose stack to
 * be up. Paths under /api/docs (Swagger static UI) are excluded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';

import { registerRoutes } from '../src/routes/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SWAGGER_PREFIX = '/api/docs';

/**
 * A stand-in for `app.db`/`app.redis`/`app.bridge`: every property read and
 * call returns the stub again, and awaiting it yields `[]`. A few route
 * plugins touch the database while registering (e.g. seeding system issue
 * labels); the stub lets them register without a live service.
 */
function inertService(): unknown {
  const target = () => undefined;
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (value: unknown) => void) => resolve([]);
      }
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

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
  'PUT /api/v1/integrations/discord',
  'POST /api/v1/integrations/discord/webhooks',
  'PUT /api/v1/integrations/discord/webhooks/:id',
  'DELETE /api/v1/integrations/discord/webhooks/:id',
  'POST /api/v1/integrations/discord/webhooks/:id/test',
  'PUT /api/v1/integrations/discord/templates/:eventType',
  'POST /api/v1/integrations/discord/templates/:eventType/reset',
  'POST /api/v1/integrations/discord/templates/:eventType/preview',
  'PUT /api/v1/integrations/discord/servers/:serverId/status-channel',
  'POST /api/v1/integrations/discord/interactions',
  'PUT /api/v1/integrations/geoip',
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

/** Mutating routes registered with no `config.audit` at all (self-audited in the handler). */
const LEGACY_MISSING_AUDIT = new Set<string>([
  'POST /api/v1/issues',
  'PATCH /api/v1/issues/:id',
  'POST /api/v1/issues/:id/comments',
  'POST /api/v1/issues/:id/links',
  'DELETE /api/v1/issues/:id/links/:linkId',
]);

/** Machine-to-machine endpoints that answer before any panel state changes. */
const MACHINE_INTEGRATION_EXCEPTIONS = new Set(['POST /api/v1/integrations/balancer/proposals']);

const routeKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;

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
  (app as any).decorate('db', inertService());
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', inertService());
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('bridge', inertService());
  for (const name of [
    'config',
    'liveBus',
    'diag',
    'makeBridgeClient',
    'installProgress',
    'statusReconciler',
  ]) {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (app as any).decorate(name, inertService());
  }
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

  // The same single registration list `server.ts` and the integration
  // harness use, so a new route module can never sit outside this guard
  // (audit #102/#116: ban-sources and banned-names did).
  await registerRoutes(app);

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

    const missing = mutating.filter(
      (r) => !Object.hasOwn(r.config, 'audit') && !LEGACY_MISSING_AUDIT.has(routeKey(r)),
    );
    if (missing.length > 0) {
      const lines = missing.map((r) => `  ${r.method} ${r.url}`).join('\n');
      throw new Error(
        `Routes missing config.audit (add { audit: { action, resource } } or { audit: false }):\n${lines}`,
      );
    }
  });

  it('mutating-verb routes with audit: false are limited to explicit machine-integration exceptions', async () => {
    const routes = await collectRoutes();
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
    const routes = await collectRoutes();
    const route = routes.find((r) => routeKey(r) === key);
    expect(route, `${key} is not registered`).toBeDefined();
    expect(route?.config.audit).toMatchObject({
      action: expect.any(String),
      resource: expect.any(String),
    });
  });

  it('the legacy exception lists only name routes that still need them', async () => {
    const routes = await collectRoutes();
    const byKey = new Map(routes.map((r) => [routeKey(r), r]));
    for (const key of LEGACY_SELF_AUDITED) {
      expect(byKey.get(key)?.config.audit, `stale LEGACY_SELF_AUDITED entry ${key}`).toBe(false);
    }
    for (const key of LEGACY_MISSING_AUDIT) {
      const route = byKey.get(key);
      expect(route, `stale LEGACY_MISSING_AUDIT entry ${key}`).toBeDefined();
      expect(Object.hasOwn(route?.config ?? {}, 'audit'), `stale entry ${key}`).toBe(false);
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
