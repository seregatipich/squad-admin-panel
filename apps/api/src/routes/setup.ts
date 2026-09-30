import { panelMeta } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
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
      // The global auth hook already rejects an unauthenticated caller with
      // 401 before this handler runs, so an `if (!req.user)` check here was
      // unreachable dead code (finding #350). Precedence below (410 before
      // 403) matches the pre-existing contract: an authenticated non-owner
      // still sees 410 once setup is done, not 403.
      const before = await app.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
      if (before[0]?.setupCompleted) {
        reply.code(410);
        return { error: 'setup_already_completed' };
      }

      if (!req.user!.permissions.isOwner) {
        reply.code(403);
        return { error: 'only_owner_can_complete_setup' };
      }

      // Condition the UPDATE on setup_completed still being false so two
      // concurrent completions can't both report success; only the winner
      // gets a returned row (finding #350).
      const updated = await app.db
        .update(panelMeta)
        .set({
          setupCompleted: true,
          organizationName: req.body.organization_name,
        })
        .where(and(eq(panelMeta.id, 1), eq(panelMeta.setupCompleted, false)))
        .returning();
      const after = updated[0];
      if (!after) {
        reply.code(410);
        return { error: 'setup_already_completed' };
      }

      req.auditSnapshots = {
        before: { organization_name: before[0]?.organizationName ?? null },
        after: { organization_name: after.organizationName },
      };

      return { ok: true };
    },
  );
};

export default setupRoutes;
