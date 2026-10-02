// The route table behind the permission matrix. It needs no database, so the
// partition guard in permission-matrix.test.ts can prove the split of the
// sweep without Postgres.
import { PERMISSIONS, type PermissionKey } from '@squad/shared-config';

/** One registered route that declares `config.permissions`. */
export interface RouteSpec {
  method: string;
  url: string;
  required: string[];
}

/**
 * How many test files share the sweep. CI shards the API suite by file, so the
 * sweep (about 5,200 sequential `inject` calls) only spreads over shards when
 * it is split across files; each part pays its own app build and token setup,
 * which is why this stays at one part per CI shard.
 */
export const PERMISSION_MATRIX_PART_COUNT = 4;

/**
 * Registers every route file that declares `config.permissions` on a bare
 * Fastify app (no database, Redis or bridge) and returns the routes it saw.
 *
 * @returns `routes` for the HTTP sweep and `wsRoutes` for the websocket routes,
 *   which `.inject()` cannot upgrade and which are only tracked by a canary.
 */
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

/** Every permission key in the catalogue; the sweep probes each route with each one alone. */
export const ALL_PERM_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

export const { routes: protectedRoutes, wsRoutes } = await collectProtectedRoutes();

/**
 * The routes one sweep file covers: those whose index in the collected table
 * is congruent to `part - 1` modulo the part count. Residues are disjoint and
 * exhaustive, so no route can be dropped or swept twice, and consecutive
 * routes (which come from the same route file and cost the same) are spread
 * evenly over the parts.
 *
 * @param routes - The full protected-route table, in registration order.
 * @param part - 1-based part number, between 1 and `PERMISSION_MATRIX_PART_COUNT`.
 * @returns The routes of that part, in their original relative order.
 * @throws If `part` is not an integer within range.
 */
export function routesForPart(routes: readonly RouteSpec[], part: number): RouteSpec[] {
  if (!Number.isInteger(part) || part < 1 || part > PERMISSION_MATRIX_PART_COUNT) {
    throw new Error(
      `permission matrix part must be an integer from 1 to ${PERMISSION_MATRIX_PART_COUNT}, got ${part}`,
    );
  }
  return routes.filter((_route, index) => index % PERMISSION_MATRIX_PART_COUNT === part - 1);
}
