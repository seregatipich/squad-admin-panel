import type { FastifyPluginAsync } from 'fastify';

/**
 * Steam OpenID 2.0 login — Phase 1 stub per TZ §2.1 scope decision.
 * The scaffolding is committed in Phase 0 (route paths reserved, 501
 * surface so clients get a clean error), and the ~40-line Steam OpenID
 * verifier will be filled in when Phase 1 work starts.
 */
const steamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/auth/steam/login', { config: { audit: false } }, async (_req, reply) => {
    reply.code(501);
    return { error: 'steam_login_stub', message: 'Steam OpenID 2.0 login lands in Phase 1' };
  });

  app.get('/api/v1/auth/steam/callback', { config: { audit: false } }, async (_req, reply) => {
    reply.code(501);
    return { error: 'steam_login_stub' };
  });
};

export default steamRoutes;
