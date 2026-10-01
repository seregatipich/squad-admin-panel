import type { FastifyPluginAsync } from 'fastify';

import roleMemberBulkRoutes from './role-members/bulk.js';
import roleMemberImportExportRoutes from './role-members/import-export.js';
import roleMemberListRoutes from './role-members/members.js';

/**
 * Role member routes (`/api/v1/roles/:id/members...`), one sub-plugin per concern.
 */
const roleMembersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(roleMemberListRoutes);
  await app.register(roleMemberImportExportRoutes);
  await app.register(roleMemberBulkRoutes);
};

export default roleMembersRoutes;
