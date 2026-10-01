import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';

import serverConfigDriftRoutes from './server-configs/drift.js';
import serverConfigFilesRoutes from './server-configs/files.js';
import serverConfigHistoryRoutes from './server-configs/history.js';

export { DRIFT_SWEEP_FILES } from '../lib/server-configs/drift.js';
export {
  ConfigServerNotFoundError,
  type ReloadOutcome,
  reloadServerConfig,
  writeVersion,
} from '../lib/server-configs/write.js';

/**
 * Server config file routes (`/api/v1/servers/:id/configs...`), one sub-plugin per
 * concern. The sub-plugins inherit the container-only guard registered here.
 * `writeVersion`, `reloadServerConfig`, `ConfigServerNotFoundError`, `ReloadOutcome`
 * and `DRIFT_SWEEP_FILES` stay importable from this module.
 */
const serverConfigRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

  await app.register(serverConfigFilesRoutes);
  await app.register(serverConfigHistoryRoutes);
  await app.register(serverConfigDriftRoutes);
};

export default serverConfigRoutes;
