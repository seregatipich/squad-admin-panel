import { users } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { loadUserPermissions } from '../lib/rbac.js';
import { resolveSession } from '../lib/sessions.js';

export const SESSION_COOKIE = '__Host-sid';

export default fp(async (app) => {
  app.addHook('preValidation', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await resolveSession(app.db, app.redis, token);
    if (!session) return;
    const userRows = await app.db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = userRows[0];
    if (!user) return;
    req.session = { id: session.id, userId: session.userId };
    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
      permissions: await loadUserPermissions(app.db, user.id),
    };
  });

  app.addHook('preHandler', async (req, reply) => {
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
