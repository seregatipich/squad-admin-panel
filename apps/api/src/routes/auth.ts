import { economySettings, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { revokeAllForPlayer, revokeSession, tokenIdFromToken } from '../lib/sessions.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

const authRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/auth/logout',
    {
      // VIPSUB-5 (#171): a self-service session must always be able to end itself.
      config: { audit: { action: 'user.logout', resource: 'session' }, selfService: true },
    },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        const sessionId = tokenIdFromToken(token);
        await revokeSession(app.db, app.redis, sessionId);
        if (req.user) {
          app.liveBus.publish({
            type: 'session.revoked',
            ts: new Date().toISOString(),
            data: { player_id: req.user.playerId, session_id: sessionId },
          });
        }
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  // VIPSUB-5 (#171): `selfService` because the web DAL's `requireSession()`
  // reads this route on every render, including the `(me)` self-service layout.
  // The response is entirely self-scoped and its capability set is frozen for
  // this batch — a self-service player simply sees their (empty) permissions.
  fast.get('/api/v1/me', { config: { audit: false, selfService: true } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    // ECON-5 (#165): the web nav hides economy-gated pages on this flag.
    const [economyRow] = await app.db
      .select({ enabled: economySettings.economyEnabled })
      .from(economySettings)
      .limit(1);
    return {
      player_id: req.user.playerId,
      steam_id64: req.user.steamId64 ? String(req.user.steamId64) : null,
      canonical_name: req.user.canonicalName,
      avatar_url: req.user.avatarUrl,
      permissions: Array.from(req.user.permissions.permissions),
      squad_permissions: Array.from(req.user.permissions.squadPermissions),
      can_manage_ban_sources: req.user.permissions.canManageBanSources,
      can_manage_clans: req.user.permissions.canManageClans,
      can_manage_issues: req.user.permissions.canManageIssues,
      can_manage_economy: req.user.permissions.canManageEconomy,
      can_handle_reports: req.user.permissions.canHandleReports,
      economy_enabled: economyRow?.enabled ?? false,
    };
  });

  fast.get('/api/v1/me/sessions', { config: { audit: false } }, async (req, reply) => {
    if (!req.user || !req.session) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    const rows = await app.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.playerId, req.user.playerId));
    return rows.map((s) => ({
      id: s.id,
      ip: s.ip,
      user_agent: s.userAgent,
      last_activity_at: s.lastActivityAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
      current: s.id === req.session?.id,
    }));
  });

  fast.delete(
    '/api/v1/me/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().min(1) }) },
      config: { audit: { action: 'user.session.revoke', resource: 'session' } },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const target = await app.db
        .select()
        .from(sessionsTable)
        .where(
          and(eq(sessionsTable.id, req.params.id), eq(sessionsTable.playerId, req.user.playerId)),
        )
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'session_not_found' };
      }
      await revokeSession(app.db, app.redis, req.params.id);
      app.liveBus.publish({
        type: 'session.revoked',
        ts: new Date().toISOString(),
        data: { player_id: req.user.playerId, session_id: req.params.id },
      });
      return { ok: true };
    },
  );

  fast.delete(
    '/api/v1/me/sessions',
    {
      config: { audit: { action: 'user.session.revoke_all', resource: 'session' } },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      await revokeAllForPlayer(app.db, app.redis, req.user.playerId, app.liveBus);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
};

export default authRoutes;
