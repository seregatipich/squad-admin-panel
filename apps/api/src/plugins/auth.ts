import { players, sessions as sessionsTable } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { loadUserPermissions } from '../lib/rbac.js';
import { resolveSession, touchSession } from '../lib/sessions.js';

export const SESSION_COOKIE = '__Host-sid';

export default fp(async (app) => {
  const ttlSeconds = app.config.SESSION_TTL_SECONDS;
  const throttleSeconds = app.config.SESSION_TOUCH_THROTTLE_SECONDS;

  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = await resolveSession(app.db, app.redis, token);
      if (session) {
        const playerRows = await app.db
          .select({
            steamId64: players.steamId64,
            canonicalName: players.canonicalName,
          })
          .from(players)
          .where(eq(players.steamId64, session.steamId64))
          .limit(1);
        const player = playerRows[0];
        if (player) {
          req.session = { id: session.id, steamId64: player.steamId64 };
          req.user = {
            steamId64: player.steamId64,
            canonicalName: player.canonicalName,
            avatarUrl: null,
            permissions: await loadUserPermissions(app.db, player.steamId64),
          };
          const touched = await touchSession({
            sessionId: session.id,
            redis: app.redis,
            now: new Date(),
            ttlSeconds,
            throttleSeconds,
            updateDb: async (expiresAt, lastActivity) => {
              await app.db
                .update(sessionsTable)
                .set({ expiresAt, lastActivityAt: lastActivity })
                .where(eq(sessionsTable.id, session.id));
            },
          });
          if (touched) {
            reply.setCookie(SESSION_COOKIE, token, {
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'lax',
              maxAge: ttlSeconds,
            });
          }
        }
      }
    }

    const required = req.routeOptions?.config?.permissions;
    if (!required || required.length === 0) return;
    if (!req.user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    for (const perm of required) {
      if (!req.user.permissions.permissions.has(perm)) {
        reply.code(403).send({ error: 'forbidden', required });
        return;
      }
    }
  });
});
