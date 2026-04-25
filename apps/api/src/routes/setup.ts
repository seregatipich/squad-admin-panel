import { organizations } from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

async function setupCompleted(app: import('fastify').FastifyInstance): Promise<boolean> {
  const rows = await app.db
    .select({ settings: organizations.settings })
    .from(organizations)
    .limit(1);
  const settings = rows[0]?.settings as Record<string, unknown> | undefined;
  return settings?.setup_complete === true;
}

const initBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
});

const setupRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/setup/check-env', { config: { audit: false } }, async (_req, reply) => {
    if (await setupCompleted(app)) {
      reply.code(410);
      return { error: 'setup_already_complete' };
    }
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const info = await app.bridge.hostInfo();
      checks.bridge = { ok: true, detail: `${info.os_name} ${info.os_version}` };
      checks.host = {
        ok: /Ubuntu|Debian/i.test(info.os_name),
        detail: `${info.os_name} ${info.os_version}`,
      };
    } catch (err) {
      checks.bridge = { ok: false, detail: (err as Error).message };
      checks.host = { ok: false, detail: 'bridge unavailable' };
    }
    checks.public_url = {
      ok: !!app.config.PANEL_PUBLIC_URL,
      detail: app.config.PANEL_PUBLIC_URL ?? '(not set)',
    };
    checks.steam_web_api = {
      ok: !!app.config.STEAM_API_KEY,
      detail: app.config.STEAM_API_KEY ? 'configured' : 'optional, not set',
    };
    const ok =
      (checks.bridge?.ok ?? false) &&
      (checks.host?.ok ?? false) &&
      (checks.public_url?.ok ?? false);
    return { ok, checks };
  });

  fast.post(
    '/api/v1/setup/init',
    {
      schema: { body: initBody },
      config: { audit: { action: 'setup.init', resource: 'organization' } },
    },
    async (req, reply) => {
      if (await setupCompleted(app)) {
        reply.code(410);
        return { error: 'setup_already_complete' };
      }
      const slug =
        req.body.slug ??
        req.body.name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 63);
      const orgId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx.insert(organizations).values({
          id: orgId,
          name: req.body.name,
          slug,
          settings: { setup_complete: true } as object,
        });
        await seedSystemRoles(tx, orgId);
      });
      return { org_id: orgId, slug };
    },
  );
};

export default setupRoutes;
