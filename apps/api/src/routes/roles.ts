import type { DatabaseClient } from '@squad/db';
import { rolePermissions, roleSquadPermissions, roles } from '@squad/db/schema';
import { isRoleColor, isSquadPermissionKey, SQUAD_PERMISSIONS } from '@squad/shared-config';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidateAllPermissionCaches, invalidatePermissionCacheForRole } from '../lib/rbac.js';

const colorSchema = z.string().refine(isRoleColor, { message: 'invalid color' });
const squadPermissionsArraySchema = z
  .array(z.string().refine(isSquadPermissionKey, { message: 'unknown squad permission key' }))
  .max(SQUAD_PERMISSIONS.length);

const createBody = z.object({
  name: z.string().min(1).max(64),
  color: colorSchema,
  description: z.string().max(256).optional(),
  squad_permissions: squadPermissionsArraySchema.default([]),
  panel_access: z.boolean().default(false),
  can_view_ips: z.boolean().default(false),
  can_assign_roles: z.boolean().default(false),
  can_edit_roles: z.boolean().default(false),
  can_manage_issues: z.boolean().default(false),
  can_manage_ban_sources: z.boolean().default(false),
  can_manage_integrations: z.boolean().default(false),
  can_manage_clans: z.boolean().default(false),
  can_manage_economy: z.boolean().default(false),
});

const updateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  color: colorSchema.optional(),
  description: z.string().max(256).nullable().optional(),
  squad_permissions: squadPermissionsArraySchema.optional(),
  panel_access: z.boolean().optional(),
  can_view_ips: z.boolean().optional(),
  can_assign_roles: z.boolean().optional(),
  can_edit_roles: z.boolean().optional(),
  can_manage_issues: z.boolean().optional(),
  can_manage_ban_sources: z.boolean().optional(),
  can_manage_integrations: z.boolean().optional(),
  can_manage_clans: z.boolean().optional(),
  can_manage_economy: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

interface RoleWithCount extends Record<string, unknown> {
  id: string;
  name: string;
  color: string;
  description: string | null;
  is_system_role: boolean;
  panel_access: boolean;
  can_view_ips: boolean;
  can_assign_roles: boolean;
  can_edit_roles: boolean;
  can_manage_issues: boolean;
  can_manage_ban_sources: boolean;
  can_manage_integrations: boolean;
  can_manage_clans: boolean;
  can_manage_economy: boolean;
  squad_permissions: string[];
  assigned_users_count: number;
}

async function listRolesWithCounts(db: DatabaseClient): Promise<RoleWithCount[]> {
  const rows = await db.execute<RoleWithCount>(sql`
    SELECT r.id, r.name, r.color, r.description, r.is_system_role,
      r.panel_access, r.can_view_ips, r.can_assign_roles, r.can_edit_roles, r.can_manage_issues,
      r.can_manage_ban_sources, r.can_manage_integrations, r.can_manage_clans,
      r.can_manage_economy,
      COALESCE(
        (SELECT array_agg(rsp.squad_permission_key ORDER BY rsp.squad_permission_key)
         FROM role_squad_permissions rsp WHERE rsp.role_id = r.id), ARRAY[]::text[]
      ) AS squad_permissions,
      (SELECT count(*)::int FROM players p WHERE p.role_id = r.id) AS assigned_users_count
    FROM roles r
    ORDER BY r.is_system_role DESC, r.name ASC
  `);
  return rows as unknown as RoleWithCount[];
}

function ensureFlagDependency(body: {
  panel_access?: boolean;
  can_assign_roles?: boolean;
  can_edit_roles?: boolean;
  can_view_ips?: boolean;
}): string | null {
  if (body.panel_access === false && (body.can_assign_roles || body.can_edit_roles)) {
    return 'panel_access_required_for_role_management';
  }
  if (body.panel_access === false && body.can_view_ips) {
    return 'panel_access_required_for_view_ips';
  }
  return null;
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
      const dep = ensureFlagDependency(req.body);
      if (dep) {
        reply.code(400);
        return { error: dep };
      }
      const id = uuidv7();
      try {
        await app.db.transaction(async (tx) => {
          await tx.insert(roles).values({
            id,
            name: req.body.name,
            color: req.body.color,
            description: req.body.description ?? null,
            isSystemRole: false,
            panelAccess: req.body.panel_access,
            canViewIps: req.body.can_view_ips,
            canAssignRoles: req.body.can_assign_roles,
            canEditRoles: req.body.can_edit_roles,
            canManageIssues: req.body.can_manage_issues,
            canManageBanSources: req.body.can_manage_ban_sources,
            canManageIntegrations: req.body.can_manage_integrations,
            canManageClans: req.body.can_manage_clans,
            canManageEconomy: req.body.can_manage_economy,
          });
          if (req.body.squad_permissions.length > 0) {
            await tx.insert(roleSquadPermissions).values(
              req.body.squad_permissions.map((squadPermissionKey) => ({
                roleId: id,
                squadPermissionKey,
              })),
            );
          }
          // Spec §2.7.1 — sync-task is enqueued in the same transaction
          // as the DB write. If Redis publish fails, the transaction
          // rolls back and the role change is not persisted.
          await publishAdminsCfgSyncForAllServers(tx, app.redis, {
            reason: 'role.create',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
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
      const merged = {
        panel_access: req.body.panel_access ?? roleRow.panelAccess,
        can_assign_roles: req.body.can_assign_roles ?? roleRow.canAssignRoles,
        can_edit_roles: req.body.can_edit_roles ?? roleRow.canEditRoles,
        can_view_ips: req.body.can_view_ips ?? roleRow.canViewIps,
      };
      const dep = ensureFlagDependency(merged);
      if (dep) {
        reply.code(400);
        return { error: dep };
      }
      try {
        await app.db.transaction(async (tx) => {
          const updates: Partial<typeof roles.$inferInsert> = {};
          if (req.body.name !== undefined) updates.name = req.body.name;
          if (req.body.color !== undefined) updates.color = req.body.color;
          if (req.body.description !== undefined) updates.description = req.body.description;
          if (req.body.panel_access !== undefined) updates.panelAccess = req.body.panel_access;
          if (req.body.can_view_ips !== undefined) updates.canViewIps = req.body.can_view_ips;
          if (req.body.can_assign_roles !== undefined)
            updates.canAssignRoles = req.body.can_assign_roles;
          if (req.body.can_edit_roles !== undefined) updates.canEditRoles = req.body.can_edit_roles;
          if (req.body.can_manage_issues !== undefined)
            updates.canManageIssues = req.body.can_manage_issues;
          if (req.body.can_manage_ban_sources !== undefined)
            updates.canManageBanSources = req.body.can_manage_ban_sources;
          if (req.body.can_manage_integrations !== undefined)
            updates.canManageIntegrations = req.body.can_manage_integrations;
          if (req.body.can_manage_clans !== undefined)
            updates.canManageClans = req.body.can_manage_clans;
          if (req.body.can_manage_economy !== undefined)
            updates.canManageEconomy = req.body.can_manage_economy;
          if (Object.keys(updates).length > 0) {
            await tx.update(roles).set(updates).where(eq(roles.id, req.params.id));
          }
          if (req.body.squad_permissions !== undefined) {
            await tx
              .delete(roleSquadPermissions)
              .where(eq(roleSquadPermissions.roleId, req.params.id));
            if (req.body.squad_permissions.length > 0) {
              await tx.insert(roleSquadPermissions).values(
                req.body.squad_permissions.map((squadPermissionKey) => ({
                  roleId: req.params.id,
                  squadPermissionKey,
                })),
              );
            }
          }
          await publishAdminsCfgSyncForAllServers(tx, app.redis, {
            reason: 'role.update',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
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
      // role_permissions/role_squad_permissions cascade; players.role_id is
      // SET NULL via FK. We invalidate per-role cache *first* so outstanding
      // requests see the new (NULL) effective role on next lookup.
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      await app.db.transaction(async (tx) => {
        await tx.delete(roles).where(eq(roles.id, req.params.id));
        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'role.delete',
          actor_player_id: req.user?.playerId ?? null,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
      });
      // Players who lost their role no longer have panel_access; sweep
      // caches because we don't know exactly which sessions remain valid.
      invalidateAllPermissionCaches();
      return { ok: true };
    },
  );
};

export default rolesRoutes;
void rolePermissions;
void and;
