import { PERMISSIONS } from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';

const permissionsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/permissions',
    { config: { permissions: ['role:view'], audit: false } },
    async () => PERMISSIONS,
  );
};

export default permissionsRoutes;
