import type { FastifyPluginAsync } from 'fastify';

const discordRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/auth/discord/login', { config: { audit: false } }, async (_req, reply) => {
    reply.code(501);
    return { error: 'discord_login_stub' };
  });

  app.get('/api/v1/auth/discord/callback', { config: { audit: false } }, async (_req, reply) => {
    reply.code(501);
    return { error: 'discord_login_stub' };
  });
};

export default discordRoutes;
