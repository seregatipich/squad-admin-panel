import { panelMeta } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const completeBody = z.object({
  organization_name: z.string().min(1).max(100).trim(),
});

const setupRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/setup/status', { config: { audit: false } }, async () => {
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
