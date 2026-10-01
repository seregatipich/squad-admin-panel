import type { FastifyPluginAsync } from 'fastify';
import { ensureSystemIssueLabels } from '../lib/issue-labels.js';

import issueLinkRoutes from './issues/links.js';
import playerIssueRoutes from './issues/player-issues.js';
import issueTicketRoutes from './issues/tickets.js';
import issueUpdateRoutes from './issues/updates.js';

/**
 * Issue tracker routes (`/api/v1/issues...` and the player card feed), one
 * sub-plugin per concern. The system labels are seeded once before any of them loads.
 */
const issuesRoutes: FastifyPluginAsync = async (app) => {
  await ensureSystemIssueLabels(app.db);

  await app.register(issueTicketRoutes);
  await app.register(issueUpdateRoutes);
  await app.register(issueLinkRoutes);
  await app.register(playerIssueRoutes);
};

export default issuesRoutes;
