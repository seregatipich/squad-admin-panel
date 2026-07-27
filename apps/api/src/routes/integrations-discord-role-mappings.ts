import { type DiscordRoleMappingRow, discordRoleMappings, roles } from '@squad/db/schema';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishDiscordRoleSync, readDiscordRoleSyncStatus } from '../lib/discord-role-sync.js';

const INTEGRATION_PERMISSION = 'integration:manage' as const;

/**
 * The only mapping source that exists today. Leaderboard-driven Discord roles
 * (top-kills, playtime tiers) are a post-STATS-3 extension and will introduce
 * their own stored source value; until then this is synthesised rather than
 * persisted so the wire contract can grow without a migration.
 */
const MAPPING_SOURCE = 'panel_role' as const;

/** Discord snowflake — up to 20 decimal digits today, bounded generously. */
const discordRoleIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,32}$/, 'invalid discord role id');

const createBody = z.object({
  role_id: z.string().uuid(),
  discord_role_id: discordRoleIdSchema,
  enabled: z.boolean().optional(),
});

const updateBody = z.object({
  discord_role_id: discordRoleIdSchema.optional(),
  enabled: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

/**
 * drizzle-orm 0.45 wraps the driver error, so the postgres `23505` lands on
 * `err.cause` rather than on the thrown object — the flat `err.code === '23505'`
 * check copied around this codebase silently misses it. Walk the chain.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function serialize(row: DiscordRoleMappingRow, roleName: string | null) {
  return {
    id: row.id,
    role_id: row.roleId,
    role_name: roleName,
    discord_role_id: row.discordRoleId,
    source: MAPPING_SOURCE,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * CRUD over `discord_role_mappings` plus the manual reconcile trigger
 * (DISCORD-5, #152). Every route is gated on the existing catalogue key
 * `integration:manage`; mutations declare `config.audit` so `plugins/audit.ts`
 * persists them. Kept out of `integrations-discord.ts` so the mutating routes
 * fall under the `audit-coverage` static guard's import list.
 */
const integrationsDiscordRoleMappingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function findMapping(id: string): Promise<DiscordRoleMappingRow | null> {
    const rows = await app.db
      .select()
      .from(discordRoleMappings)
      .where(eq(discordRoleMappings.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async function roleName(roleId: string): Promise<string | null> {
    const rows = await app.db
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  fast.get(
    '/api/v1/integrations/discord/role-mappings',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select({ mapping: discordRoleMappings, roleName: roles.name })
        .from(discordRoleMappings)
        .innerJoin(roles, eq(roles.id, discordRoleMappings.roleId))
        .orderBy(asc(discordRoleMappings.createdAt));
      return {
        items: rows.map((row) => serialize(row.mapping, row.roleName)),
        status: await readDiscordRoleSyncStatus(app.redis),
      };
    },
  );

  fast.post(
    '/api/v1/integrations/discord/role-mappings',
    {
      schema: { body: createBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.role_mapping.create', resource: 'discord_role_mapping' },
      },
    },
    async (req, reply) => {
      const name = await roleName(req.body.role_id);
      if (name === null) {
        reply.code(404);
        return { error: 'role_not_found' };
      }

      const id = uuidv7();
      try {
        await app.db.insert(discordRoleMappings).values({
          id,
          roleId: req.body.role_id,
          discordRoleId: req.body.discord_role_id,
          enabled: req.body.enabled ?? true,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: 'role_mapping_exists' };
        }
        throw err;
      }

      const created = await findMapping(id);
      if (!created) {
        reply.code(500);
        return { error: 'mapping_create_failed' };
      }
      // A new mapping changes what every holder of the panel role should have
      // in Discord, so re-derive everyone rather than guess.
      await publishDiscordRoleSync(app.redis, null, 'role_mapping.create', app.log);
      reply.code(201);
      return serialize(created, name);
    },
  );

  fast.patch(
    '/api/v1/integrations/discord/role-mappings/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.role_mapping.update', resource: 'discord_role_mapping' },
      },
    },
    async (req, reply) => {
      const existing = await findMapping(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'mapping_not_found' };
      }

      await app.db
        .update(discordRoleMappings)
        .set({
          discordRoleId: req.body.discord_role_id ?? existing.discordRoleId,
          enabled: req.body.enabled ?? existing.enabled,
          updatedAt: new Date(),
        })
        .where(eq(discordRoleMappings.id, req.params.id));

      const updated = await findMapping(req.params.id);
      if (!updated) {
        reply.code(404);
        return { error: 'mapping_not_found' };
      }
      await publishDiscordRoleSync(app.redis, null, 'role_mapping.update', app.log);
      return serialize(updated, await roleName(updated.roleId));
    },
  );

  fast.delete(
    '/api/v1/integrations/discord/role-mappings/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.role_mapping.delete', resource: 'discord_role_mapping' },
      },
    },
    async (req, reply) => {
      const existing = await findMapping(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'mapping_not_found' };
      }
      await app.db.delete(discordRoleMappings).where(eq(discordRoleMappings.id, req.params.id));
      // Deliberately does NOT strip the Discord role: once the mapping is gone
      // the panel no longer manages that Discord role, so reconcile must leave
      // it alone rather than mass-revoke it from every holder.
      await publishDiscordRoleSync(app.redis, null, 'role_mapping.delete', app.log);
      return { ok: true };
    },
  );

  fast.post(
    '/api/v1/integrations/discord/role-mappings/reconcile',
    {
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.role_mapping.reconcile', resource: 'discord_role_mapping' },
      },
    },
    async () => {
      await publishDiscordRoleSync(app.redis, null, 'manual_reconcile', app.log);
      return { enqueued: true };
    },
  );
};

export default integrationsDiscordRoleMappingsRoutes;
