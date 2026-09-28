import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadBanAltWarning } from '../lib/ban-alt-warning.js';
import { panelGuard } from '../lib/panel-guard.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });

/** ALT-7 privacy-aware pre-ban warning, gated by panel_access. */
const playerBanAltWarningRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/ban-alt-warning',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const warning = await loadBanAltWarning(app, {
        playerId: req.params.playerId,
        canViewIps: req.user?.permissions.permissions.has('player:view_ips') ?? false,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      if (!warning) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      return warning;
    },
  );
};

export default playerBanAltWarningRoutes;
