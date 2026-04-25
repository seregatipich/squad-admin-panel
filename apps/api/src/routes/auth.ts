import { sessions as sessionsTable } from '@squad/db/schema';
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
    { config: { audit: { action: 'user.logout', resource: 'session' } } },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        await revokeSession(app.db, app.redis, tokenIdFromToken(token));
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  fast.get('/api/v1/me', { config: { audit: false } }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    return {
      steam_id64: String(req.user.steamId64),
      canonical_name: req.user.canonicalName,
      avatar_url: req.user.avatarUrl,
      permissions: Array.from(req.user.permissions.permissions),
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
      .where(eq(sessionsTable.steamId64, req.user.steamId64));
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
          and(eq(sessionsTable.id, req.params.id), eq(sessionsTable.steamId64, req.user.steamId64)),
        )
        .limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'session_not_found' };
      }
      await revokeSession(app.db, app.redis, req.params.id);
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
      await revokeAllForPlayer(app.db, app.redis, req.user.steamId64);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
};

export default authRoutes;
