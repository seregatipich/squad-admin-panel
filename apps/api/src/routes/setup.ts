import { organizationMembers, organizations, userRoleAssignments, users } from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { hashPassword } from '../lib/argon.js';

async function setupCompleted(app: import('fastify').FastifyInstance): Promise<boolean> {
  const rows = await app.db.select({ id: organizations.id }).from(organizations).limit(1);
  return rows.length > 0;
}

const createOrgBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
});

const createOwnerBody = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(120),
  password: z.string().min(12).max(512),
});

const setupRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  const guard = async (
    _req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    if (await setupCompleted(app)) {
      reply.code(410).send({ error: 'setup_already_complete' });
    }
  };

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
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, checks };
  });

  fast.post(
    '/api/v1/setup/org',
    {
      config: { audit: { action: 'setup.org.create', resource: 'organization' } },
      schema: { body: createOrgBody },
      preHandler: guard,
    },
    async (req) => {
      const slug =
        req.body.slug ??
        req.body.name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 63);
      const orgId = uuidv7();
      await app.db.insert(organizations).values({
        id: orgId,
        name: req.body.name,
        slug,
      });
      const seeded = await seedSystemRoles(app.db, orgId);
      return { org_id: orgId, slug, system_roles: seeded };
    },
  );

  fast.post(
    '/api/v1/setup/owner',
    {
      config: { audit: { action: 'setup.owner.create', resource: 'user' } },
      schema: { body: createOwnerBody },
      preHandler: guard,
    },
    async (req, reply) => {
      const orgs = await app.db.select().from(organizations).limit(1);
      const org = orgs[0];
      if (!org) {
        reply.code(400);
        return { error: 'no_organization_yet' };
      }
      const email = req.body.email.toLowerCase();
      const existing = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing.length > 0) {
        reply.code(409);
        return { error: 'email_taken' };
      }
      const hash = await hashPassword(req.body.password);
      const userId = uuidv7();
      await app.db.insert(users).values({
        id: userId,
        email,
        displayName: req.body.display_name,
        passwordHash: hash,
      });
      const ownerRole = await app.db.query.roles.findFirst({
        where: (r, { and, eq: e }) => and(e(r.orgId, org.id), e(r.name, 'Owner')),
      });
      if (!ownerRole) {
        reply.code(500);
        return { error: 'owner_role_missing' };
      }
      await app.db.insert(userRoleAssignments).values({
        userId,
        roleId: ownerRole.id,
      });
      await app.db.insert(organizationMembers).values({
        userId,
        orgId: org.id,
        primaryRoleId: ownerRole.id,
      });
      return { user_id: userId, email, org_id: org.id };
    },
  );

  fast.post(
    '/api/v1/setup/finalize',
    {
      config: { audit: { action: 'setup.finalize', resource: 'organization' } },
      preHandler: guard,
    },
    async () => {
      const orgs = await app.db.select().from(organizations).limit(1);
      const org = orgs[0];
      if (!org) return { ok: false, error: 'no_organization_yet' };
      await app.db
        .update(organizations)
        .set({ settings: { ...(org.settings as Record<string, unknown>), setup_complete: true } })
        .where(eq(organizations.id, org.id));
      return { ok: true };
    },
  );
};

export default setupRoutes;
