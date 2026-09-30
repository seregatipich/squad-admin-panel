import type { DatabaseClient } from '@squad/db';
import { players, rolePermissions, roleSquadPermissions, roles, vipTiers } from '@squad/db/schema';
import {
  isAdminsCfgSafeRoleName,
  isRoleColor,
  isSquadPermissionKey,
  SQUAD_PERMISSIONS,
} from '@squad/shared-config';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { uniqueViolationConstraint } from '../lib/pg-errors.js';
import {
  buildRolePermissionContext,
  invalidateAllPermissionCaches,
  invalidatePermissionCacheForRole,
} from '../lib/rbac.js';
import {
  capabilitiesBeyondActor,
  loadRoleGrant,
  type RoleGrant,
  roleCapabilities,
  roleCeilingError,
} from '../lib/role-guards.js';
import { checkGrantsWithinActor, checkRoleWithinActor } from '../lib/role-hierarchy.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const colorSchema = z.string().refine(isRoleColor, { message: 'invalid color' });
/** Role names become Admins.cfg group names verbatim, so they must not alter its syntax (#11). */
const roleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isAdminsCfgSafeRoleName, { message: 'role_name_invalid' });
/**
 * Squad permission keys of a role, deduplicated: `role_squad_permissions` is
 * keyed on (role_id, key), so a repeated key would otherwise surface as a
 * unique violation.
 */
const squadPermissionsArraySchema = z
  .array(z.string().refine(isSquadPermissionKey, { message: 'unknown squad permission key' }))
  .max(SQUAD_PERMISSIONS.length)
  .transform((keys) => [...new Set(keys)]);

const createBody = z.object({
  name: roleNameSchema,
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
  can_handle_reports: z.boolean().default(false),
  can_manage_infrastructure: z.boolean().default(false),
});

const updateBody = z.object({
  name: roleNameSchema.optional(),
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
  can_handle_reports: z.boolean().optional(),
  can_manage_infrastructure: z.boolean().optional(),
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
  can_handle_reports: boolean;
  can_manage_infrastructure: boolean;
  squad_permissions: string[];
  assigned_users_count: number;
}

/**
 * Roles with their squad permissions and assigned-player counts, system roles
 * first. `roleId` narrows the read to that one role, so single-role responses
 * do not aggregate every role.
 */
async function listRolesWithCounts(db: DatabaseClient, roleId?: string): Promise<RoleWithCount[]> {
  const rows = await db.execute<RoleWithCount>(sql`
    SELECT r.id, r.name, r.color, r.description, r.is_system_role,
      r.panel_access, r.can_view_ips, r.can_assign_roles, r.can_edit_roles, r.can_manage_issues,
      r.can_manage_ban_sources, r.can_manage_integrations, r.can_manage_clans,
      r.can_manage_economy, r.can_handle_reports, r.can_manage_infrastructure,
      COALESCE(
        (SELECT array_agg(rsp.squad_permission_key ORDER BY rsp.squad_permission_key)
         FROM role_squad_permissions rsp WHERE rsp.role_id = r.id), ARRAY[]::text[]
      ) AS squad_permissions,
      (SELECT count(*)::int FROM players p WHERE p.role_id = r.id) AS assigned_users_count
    FROM roles r
    ${roleId === undefined ? sql`` : sql`WHERE r.id = ${roleId}`}
    ORDER BY r.is_system_role DESC, r.name ASC
  `);
  return [...rows];
}

/** True when `err` is the unique violation of the role name (`roles_name_key`). */
function isRoleNameTaken(err: unknown): boolean {
  return uniqueViolationConstraint(err) === 'roles_name_key';
}

/** One role as `GET /api/v1/roles/:id` returns it; also the audit before/after snapshot. */
async function loadRoleSnapshot(db: DatabaseClient, id: string): Promise<RoleWithCount | null> {
  const [role] = await listRolesWithCounts(db, id);
  return role ?? null;
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

  async function listMemberIds(roleId: string): Promise<string[]> {
    const rows = await app.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.roleId, roleId));
    return rows.map((row) => row.id);
  }

  // A role that loses panel_access must not leave its members' live sessions behind.
  async function revokeMemberSessions(playerIds: string[]): Promise<void> {
    for (const playerId of playerIds) {
      await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
    }
  }

  fast.get('/api/v1/roles', { config: { permissions: ['role:view'], audit: false } }, async () => {
    return listRolesWithCounts(app.db);
  });

  fast.get(
    '/api/v1/roles/:id',
    { schema: { params: idParam }, config: { permissions: ['role:view'], audit: false } },
    async (req, reply) => {
      const [found] = await listRolesWithCounts(app.db, req.params.id);
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
      const requested: RoleGrant = {
        panelAccess: req.body.panel_access,
        canViewIps: req.body.can_view_ips,
        canAssignRoles: req.body.can_assign_roles,
        canEditRoles: req.body.can_edit_roles,
        canManageIssues: req.body.can_manage_issues,
        canManageBanSources: req.body.can_manage_ban_sources,
        canManageIntegrations: req.body.can_manage_integrations,
        canManageClans: req.body.can_manage_clans,
        canManageEconomy: req.body.can_manage_economy,
        canManageMedia: false,
        canHandleReports: req.body.can_handle_reports,
        // roles.combat_view defaults to true and this route does not set it.
        combatView: true,
        squadPermissions: req.body.squad_permissions,
        permissionKeys: [],
      };
      const beyond = capabilitiesBeyondActor(roleCapabilities(requested), req.user?.permissions);
      if (beyond.length > 0) {
        reply.code(403);
        return roleCeilingError(beyond);
      }
      const id = uuidv7();
      const proposed = buildRolePermissionContext(
        id,
        {
          name: req.body.name,
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
          canManageMedia: false,
          canHandleReports: req.body.can_handle_reports,
          canManageInfrastructure: req.body.can_manage_infrastructure,
          // Column default for a new role (`roles.combat_view`).
          combatView: true,
          squadPermissions: req.body.squad_permissions,
        },
        [],
      );
      const hierarchyRefusal = checkGrantsWithinActor(req.user, proposed);
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
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
            canHandleReports: req.body.can_handle_reports,
            canManageInfrastructure: req.body.can_manage_infrastructure,
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
          // as the DB write; the relay publishes it only after commit.
          await publishAdminsCfgSyncForAllServers(tx, {
            reason: 'role.create',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
        });
      } catch (err) {
        if (isRoleNameTaken(err)) {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      reply.code(201);
      const created = await loadRoleSnapshot(app.db, id);
      req.auditSnapshots = { before: null, after: created, targetId: id };
      return created;
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
      if (req.user && !req.user.permissions.isOwner && req.user.permissions.roleId === roleRow.id) {
        reply.code(403);
        return { error: 'cannot_edit_own_role' };
      }
      const currentRefusal = await checkRoleWithinActor(app.db, req.user, roleRow.id);
      if (currentRefusal) {
        reply.code(403);
        return currentRefusal;
      }
      const currentSquad = await app.db
        .select({ key: roleSquadPermissions.squadPermissionKey })
        .from(roleSquadPermissions)
        .where(eq(roleSquadPermissions.roleId, roleRow.id));
      const explicit = await app.db
        .select({ key: rolePermissions.permissionKey })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleRow.id));
      const proposed = buildRolePermissionContext(
        roleRow.id,
        {
          ...roleRow,
          name: req.body.name ?? roleRow.name,
          panelAccess: req.body.panel_access ?? roleRow.panelAccess,
          canViewIps: req.body.can_view_ips ?? roleRow.canViewIps,
          canAssignRoles: req.body.can_assign_roles ?? roleRow.canAssignRoles,
          canEditRoles: req.body.can_edit_roles ?? roleRow.canEditRoles,
          canManageIssues: req.body.can_manage_issues ?? roleRow.canManageIssues,
          canManageBanSources: req.body.can_manage_ban_sources ?? roleRow.canManageBanSources,
          canManageIntegrations: req.body.can_manage_integrations ?? roleRow.canManageIntegrations,
          canManageClans: req.body.can_manage_clans ?? roleRow.canManageClans,
          canManageEconomy: req.body.can_manage_economy ?? roleRow.canManageEconomy,
          canHandleReports: req.body.can_handle_reports ?? roleRow.canHandleReports,
          squadPermissions: req.body.squad_permissions ?? currentSquad.map((entry) => entry.key),
        },
        explicit.map((entry) => entry.key),
      );
      const proposedRefusal = checkGrantsWithinActor(req.user, proposed);
      if (proposedRefusal) {
        reply.code(403);
        return proposedRefusal;
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
      // Privilege ceiling (#1237): whatever this edit newly grants must already
      // be held by the editor; capabilities the role had before are untouched.
      const beforeGrant = await loadRoleGrant(app.db, req.params.id);
      if (!beforeGrant) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      const afterGrant: RoleGrant = {
        panelAccess: merged.panel_access,
        canViewIps: merged.can_view_ips,
        canAssignRoles: merged.can_assign_roles,
        canEditRoles: merged.can_edit_roles,
        canManageIssues: req.body.can_manage_issues ?? roleRow.canManageIssues,
        canManageBanSources: req.body.can_manage_ban_sources ?? roleRow.canManageBanSources,
        canManageIntegrations: req.body.can_manage_integrations ?? roleRow.canManageIntegrations,
        canManageClans: req.body.can_manage_clans ?? roleRow.canManageClans,
        canManageEconomy: req.body.can_manage_economy ?? roleRow.canManageEconomy,
        canManageMedia: roleRow.canManageMedia,
        canHandleReports: req.body.can_handle_reports ?? roleRow.canHandleReports,
        combatView: roleRow.combatView,
        squadPermissions: req.body.squad_permissions ?? beforeGrant.squadPermissions,
        permissionKeys: beforeGrant.permissionKeys,
      };
      const alreadyGranted = roleCapabilities(beforeGrant);
      const newlyGranted = [...roleCapabilities(afterGrant)].filter(
        (capability) => !alreadyGranted.has(capability),
      );
      const beyond = capabilitiesBeyondActor(newlyGranted, req.user?.permissions);
      if (beyond.length > 0) {
        reply.code(403);
        return roleCeilingError(beyond);
      }
      const before = await loadRoleSnapshot(app.db, req.params.id);
      const memberIds = await listMemberIds(req.params.id);
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
          if (req.body.can_handle_reports !== undefined)
            updates.canHandleReports = req.body.can_handle_reports;
          if (req.body.can_manage_infrastructure !== undefined)
            updates.canManageInfrastructure = req.body.can_manage_infrastructure;
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
          // Admins.cfg carries only a role's name and squad permissions, so
          // colour, description and panel flags never need a config sync.
          const affectsAdminsCfg =
            (req.body.name !== undefined && req.body.name !== roleRow.name) ||
            req.body.squad_permissions !== undefined;
          if (affectsAdminsCfg) {
            await publishAdminsCfgSyncForAllServers(tx, {
              reason: 'role.update',
              actor_player_id: req.user?.playerId ?? null,
              enqueued_at: new Date().toISOString(),
              request_id: req.id,
            });
          }
        });
      } catch (err) {
        if (isRoleNameTaken(err)) {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      const after = await loadRoleSnapshot(app.db, req.params.id);
      req.auditSnapshots = { before, after };
      if (req.body.panel_access === false && roleRow.panelAccess) {
        await revokeMemberSessions(memberIds);
      }
      return after;
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
      // Deleting a role strips it from every holder, so a role above the
      // actor is as off-limits here as it is to editing.
      const hierarchyRefusal = await checkRoleWithinActor(app.db, req.user, deleteTarget.id);
      if (hierarchyRefusal) {
        reply.code(403);
        return hierarchyRefusal;
      }
      // A VIP tier maps to an RBAC role via vip_tiers.role_id (ON DELETE
      // RESTRICT, migration 0035). Reject before any cache churn or delete work
      // so a referenced role returns a clean 409 rather than a raw FK-violation
      // 500 (VIPSUB-3, #169).
      const referencingTier = await app.db
        .select({ id: vipTiers.id })
        .from(vipTiers)
        .where(eq(vipTiers.roleId, req.params.id))
        .limit(1);
      if (referencingTier.length > 0) {
        reply.code(409);
        return { error: 'role_referenced_by_vip_tier' };
      }
      const before = await loadRoleSnapshot(app.db, req.params.id);
      const memberIds = await listMemberIds(req.params.id);
      try {
        await app.db.transaction(async (tx) => {
          await tx
            .update(players)
            .set({ roleId: null, roleExpiresAt: null, roleComment: null })
            .where(eq(players.roleId, req.params.id));
          await tx.delete(roles).where(eq(roles.id, req.params.id));
          await publishAdminsCfgSyncForAllServers(tx, {
            reason: 'role.delete',
            actor_player_id: req.user?.playerId ?? null,
            enqueued_at: new Date().toISOString(),
            request_id: req.id,
          });
        });
      } catch (err) {
        // Backstop for any other ON DELETE RESTRICT referrer added in future:
        // a foreign-key violation maps to a clean 409, never a 500.
        if (
          (err as { code?: string }).code === '23503' ||
          (err as { cause?: { code?: string } }).cause?.code === '23503'
        ) {
          reply.code(409);
          return { error: 'role_in_use' };
        }
        throw err;
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      // Players who lost their role no longer have panel_access; sweep
      // caches because we don't know exactly which sessions remain valid.
      invalidateAllPermissionCaches();
      req.auditSnapshots = { before, after: null };
      if (deleteTarget.panelAccess) await revokeMemberSessions(memberIds);
      return { ok: true };
    },
  );
};

export default rolesRoutes;
