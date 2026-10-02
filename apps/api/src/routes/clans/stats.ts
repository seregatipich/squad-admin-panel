import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  computeClanStats,
  resolveStatsWindow,
  statsExportQuery,
  statsQuery,
} from '../../lib/clan-stats.js';
import { clanAccess } from '../../lib/clans/access.js';
import { clanIdParams } from '../../lib/clans/common.js';
import { requestUser } from '../../lib/request-user.js';

/** Clan online-time statistics and their CSV export. */
const clanStatsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan } = clanAccess(app);

  fast.get(
    '/api/v1/clans/:id/stats',
    {
      schema: { params: clanIdParams, querystring: statsQuery },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const window = resolveStatsWindow(req.query.from, req.query.to);
      if (!window) {
        reply.code(400);
        return { error: 'invalid_range' };
      }
      return computeClanStats(app.db, clan.id, window.fromDay, window.toDay);
    },
  );

  fast.get(
    '/api/v1/clans/:id/stats/export',
    {
      schema: { params: clanIdParams, querystring: statsExportQuery },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(404);
        return { error: 'clan_not_found' };
      }
      const window = resolveStatsWindow(req.query.from, req.query.to);
      if (!window) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.code(400);
        return { error: 'invalid_range' };
      }
      const stats = await computeClanStats(app.db, clan.id, window.fromDay, window.toDay);

      const lines = [
        'day,online_seconds,boost_seconds',
        ...stats.chart.map(
          (point) => `${point.day},${point.online_seconds},${point.boost_seconds}`,
        ),
      ];
      const body = `${lines.join('\r\n')}\r\n`;
      const stamp = new Date().toISOString().slice(0, 10);

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="clan-${clan.id}-stats-${stamp}.csv"`,
      );
      return body;
    },
  );
};

export default clanStatsRoutes;
