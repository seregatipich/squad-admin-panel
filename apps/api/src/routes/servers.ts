import type { FastifyPluginAsync } from 'fastify';

import serverCatalogRoutes from './servers/catalog.js';
import serverRegistryRoutes from './servers/registry.js';
import serverStartRoutes from './servers/start.js';
import serverStopRoutes from './servers/stop.js';

/**
 * Server routes (`/api/v1/servers...`), one sub-plugin per concern.
 */
const serverRoutes: FastifyPluginAsync = async (app) => {
  await app.register(serverCatalogRoutes);
  await app.register(serverRegistryRoutes);
  await app.register(serverStartRoutes);
  await app.register(serverStopRoutes);
};

export default serverRoutes;
