import type { FastifyPluginAsync } from 'fastify';

import clanDirectoryRoutes from './clans/directory.js';
import clanMatchesRoutes from './clans/matches.js';
import clanMembersRoutes from './clans/members.js';
import clanPriorityRoutes from './clans/priority.js';
import clanRosterRoutes from './clans/roster.js';
import clanSettingsRoutes from './clans/settings.js';
import clanStatsRoutes from './clans/stats.js';

/**
 * Clan routes (`/api/v1/clans...`), one sub-plugin per concern, registered in the
 * order the routes were originally declared.
 */
const clansRoutes: FastifyPluginAsync = async (app) => {
  await app.register(clanDirectoryRoutes);
  await app.register(clanMatchesRoutes);
  await app.register(clanStatsRoutes);
  await app.register(clanSettingsRoutes);
  await app.register(clanRosterRoutes);
  await app.register(clanMembersRoutes);
  await app.register(clanPriorityRoutes);
};

export default clansRoutes;
