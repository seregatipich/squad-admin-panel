import type { DatabaseClient } from '@squad/db';
import { rolePermissions, roles } from '@squad/db/schema';
import { isPermissionKey, isRoleColor, PERMISSIONS } from '@squad/shared-config';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { invalidatePermissionCacheForRole } from '../lib/rbac.js';

const colorSchema = z.string().refine(isRoleColor, { message: 'invalid color' });
const permissionsArraySchema = z
  .array(z.string().refine(isPermissionKey, { message: 'unknown permission key' }))
  .max(PERMISSIONS.length);

const createBody = z.object({
  name: z.string().min(1).max(64),
  color: colorSchema,
  description: z.string().max(256).optional(),
  permissions: permissionsArraySchema,
});

const updateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  color: colorSchema.optional(),
  description: z.string().max(256).nullable().optional(),
  permissions: permissionsArraySchema.optional(),
});

const idParam = z.object({ id: z.string().uuid() });

interface RoleWithCount extends Record<string, unknown> {
  id: string;
  name: string;
  color: string;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
  assigned_users_count: number;
}

async function listRolesWithCounts(db: DatabaseClient): Promise<RoleWithCount[]> {
  const rows = await db.execute<RoleWithCount>(sql`
    SELECT r.id, r.name, r.color, r.description, r.is_system_role,
      COALESCE(
        (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
         FROM role_permissions rp WHERE rp.role_id = r.id), ARRAY[]::text[]
      ) AS permissions,
      (SELECT count(*)::int FROM players p WHERE p.role_id = r.id) AS assigned_users_count
    FROM roles r
    ORDER BY r.is_system_role DESC, r.name ASC
  `);
  return rows as unknown as RoleWithCount[];
}

const rolesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/roles', { config: { permissions: ['role:view'], audit: false } }, async () => {
    return listRolesWithCounts(app.db);
  });

  fast.get(
    '/api/v1/roles/:id',
    { schema: { params: idParam }, config: { permissions: ['role:view'], audit: false } },
    async (req, reply) => {
      const all = await listRolesWithCounts(app.db);
      const found = all.find((r) => r.id === req.params.id);
      if (!found) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      return found;
    },
  );

  fast.post(
    '/api/v1/roles',
    {
      schema: { body: createBody },
      config: { permissions: ['role:create'], audit: { action: 'role.create', resource: 'role' } },
    },
    async (req, reply) => {
      const id = uuidv7();
      try {
        await app.db.transaction(async (tx) => {
          await tx.insert(roles).values({
            id,
            name: req.body.name,
            color: req.body.color,
            description: req.body.description ?? null,
            isSystemRole: false,
          });
          if (req.body.permissions.length > 0) {
            await tx
              .insert(rolePermissions)
              .values(req.body.permissions.map((permissionKey) => ({ roleId: id, permissionKey })));
          }
        });
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      reply.code(201);
      const fresh = await listRolesWithCounts(app.db);
      return fresh.find((r) => r.id === id);
    },
  );

  fast.put(
    '/api/v1/roles/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: { permissions: ['role:edit'], audit: { action: 'role.update', resource: 'role' } },
    },
    async (req, reply) => {
      const target = await app.db.select().from(roles).where(eq(roles.id, req.params.id)).limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
      const roleRow = target[0]!;
      if (roleRow.isSystemRole && roleRow.name === 'Owner') {
        reply.code(400);
        return { error: 'owner_role_immutable' };
      }
      try {
        await app.db.transaction(async (tx) => {
          const updates: Partial<typeof roles.$inferInsert> = {};
          if (req.body.name !== undefined) updates.name = req.body.name;
          if (req.body.color !== undefined) updates.color = req.body.color;
          if (req.body.description !== undefined) updates.description = req.body.description;
          if (Object.keys(updates).length > 0) {
            await tx.update(roles).set(updates).where(eq(roles.id, req.params.id));
          }
          if (req.body.permissions !== undefined) {
            await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, req.params.id));
            if (req.body.permissions.length > 0) {
              await tx.insert(rolePermissions).values(
                req.body.permissions.map((permissionKey) => ({
                  roleId: req.params.id,
                  permissionKey,
                })),
              );
            }
          }
        });
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      const fresh = await listRolesWithCounts(app.db);
      return fresh.find((r) => r.id === req.params.id);
    },
  );

  fast.delete(
    '/api/v1/roles/:id',
    {
      schema: { params: idParam },
      config: {
        permissions: ['role:delete'],
        audit: { action: 'role.delete', resource: 'role' },
      },
    },
    async (req, reply) => {
      const target = await app.db.select().from(roles).where(eq(roles.id, req.params.id)).limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
      const deleteTarget = target[0]!;
      if (deleteTarget.isSystemRole && deleteTarget.name === 'Owner') {
        reply.code(400);
        return { error: 'owner_role_immutable' };
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      await app.db.delete(roles).where(eq(roles.id, req.params.id));
      return { ok: true };
    },
  );
};

export default rolesRoutes;
