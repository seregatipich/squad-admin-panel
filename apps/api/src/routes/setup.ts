import { panelMeta } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const completeBody = z.object({
  // Trim before the length check so a whitespace-only name is rejected (400)
  // rather than persisted as an empty string into a setup that then locks (410).
  organization_name: z.string().trim().min(1).max(100),
});

const setupRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  // Intentionally NOT gated behind the setup_completed 410: the wizard page is a
  // client-rendered SPA that has no other way to learn it must redirect away once
  // setup is done. `/status` therefore stays a public 200 status probe for the
  // whole lifecycle (before and after completion); the wizard becomes unreachable
  // by reading `setup_completed: true` here and redirecting to `/`. Only the
  // mutating `/setup/complete` returns 410 after completion (see below).
  fast.get('/api/v1/setup/status', { config: { audit: false, public: true } }, async () => {
    const meta = await app.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    const row = meta[0];
    return {
      setup_completed: row?.setupCompleted ?? false,
      first_owner_claimed: row?.firstOwnerClaimed ?? false,
    };
  });

  fast.post(
    '/api/v1/setup/complete',
    {
      schema: { body: completeBody },
      config: { audit: { action: 'setup.complete', resource: 'panel' } },
    },
    async (req, reply) => {
      const meta = await app.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
      if (meta[0]?.setupCompleted) {
        reply.code(410);
        return { error: 'setup_already_completed' };
      }

      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      if (!req.user.permissions.isOwner) {
        reply.code(403);
        return { error: 'only_owner_can_complete_setup' };
      }

      await app.db
        .update(panelMeta)
        .set({
          setupCompleted: true,
          organizationName: req.body.organization_name,
        })
        .where(eq(panelMeta.id, 1));

      return { ok: true };
    },
  );
};

export default setupRoutes;
