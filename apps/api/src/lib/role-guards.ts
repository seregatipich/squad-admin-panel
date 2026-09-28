import type { DatabaseClient } from '@squad/db';
import { rolePermissions, roleSquadPermissions, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { PermissionContext } from './rbac.js';

/**
 * Privilege ceiling for role management, shared by `routes/roles.ts`,
 * `routes/role-members.ts` and `routes/players.ts`: an actor may only grant
 * capabilities they hold themselves, so `can_assign_roles` /
 * `can_edit_roles` can no longer be turned into "everything except Owner" by
 * assigning or editing a stronger role (issue #41, findings #259 and #1237).
 * The system Owner is exempt.
 */

/**
 * A capability a role can grant, in a flat string form so role grants and
 * actor contexts compare as sets: a role flag column (`can_view_ips`), a
 * live-Squad permission (`squad:ban`) or an explicit catalogue key from
 * `role_permissions` (`perm:audit:view`).
 */
export type RoleCapability = string;

/** The capability-bearing columns of a `roles` row. */
export interface RoleGrantRow {
  panelAccess: boolean;
  canViewIps: boolean;
  canAssignRoles: boolean;
  canEditRoles: boolean;
  canManageIssues: boolean;
  canManageBanSources: boolean;
  canManageIntegrations: boolean;
  canManageClans: boolean;
  canManageEconomy: boolean;
  canManageMedia: boolean;
  canHandleReports: boolean;
  combatView: boolean;
}

/** Everything a role grants its members. */
export interface RoleGrant extends RoleGrantRow {
  squadPermissions: readonly string[];
  permissionKeys: readonly string[];
}

/**
 * Maps a role flag onto its capability name and the value it takes in a
 * member's {@link PermissionContext}. Flags that `loadUserPermissions` only
 * honours together with `panel_access` are gated the same way here, so a flag
 * that would have no effect is not counted as a grant.
 */
const FLAG_CAPABILITIES: ReadonlyArray<{
  capability: RoleCapability;
  granted: (row: RoleGrantRow) => boolean;
  held: (ctx: PermissionContext) => boolean;
}> = [
  { capability: 'panel_access', granted: (r) => r.panelAccess, held: (c) => c.panelAccess },
  { capability: 'can_view_ips', granted: (r) => r.canViewIps, held: (c) => c.canViewIps },
  {
    capability: 'can_assign_roles',
    granted: (r) => r.canAssignRoles,
    held: (c) => c.canAssignRoles,
  },
  { capability: 'can_edit_roles', granted: (r) => r.canEditRoles, held: (c) => c.canEditRoles },
  {
    capability: 'can_manage_issues',
    granted: (r) => r.canManageIssues,
    held: (c) => c.canManageIssues,
  },
  {
    capability: 'can_manage_ban_sources',
    granted: (r) => r.panelAccess && r.canManageBanSources,
    held: (c) => c.canManageBanSources,
  },
  {
    capability: 'can_manage_integrations',
    granted: (r) => r.canManageIntegrations,
    held: (c) => c.canManageIntegrations,
  },
  {
    capability: 'can_manage_clans',
    granted: (r) => r.canManageClans,
    held: (c) => c.canManageClans,
  },
  {
    capability: 'can_manage_economy',
    granted: (r) => r.panelAccess && r.canManageEconomy,
    held: (c) => c.canManageEconomy,
  },
  {
    capability: 'can_manage_media',
    granted: (r) => r.panelAccess && r.canManageMedia,
    held: (c) => c.canManageMedia,
  },
  {
    capability: 'can_handle_reports',
    granted: (r) => r.canHandleReports,
    held: (c) => c.canHandleReports,
  },
  {
    capability: 'combat_view',
    granted: (r) => r.panelAccess && r.combatView,
    held: (c) => c.combatView,
  },
];

/**
 * Loads the full grant of one role: its flag columns, live-Squad permissions
 * and explicit `role_permissions` keys.
 *
 * @param db - database handle (a transaction works too).
 * @param roleId - the role to load.
 * @returns the grant, or `null` when the role does not exist.
 */
export async function loadRoleGrant(
  db: Pick<DatabaseClient, 'select'>,
  roleId: string,
): Promise<RoleGrant | null> {
  const rows = await db
    .select({
      panelAccess: roles.panelAccess,
      canViewIps: roles.canViewIps,
      canAssignRoles: roles.canAssignRoles,
      canEditRoles: roles.canEditRoles,
      canManageIssues: roles.canManageIssues,
      canManageBanSources: roles.canManageBanSources,
      canManageIntegrations: roles.canManageIntegrations,
      canManageClans: roles.canManageClans,
      canManageEconomy: roles.canManageEconomy,
      canManageMedia: roles.canManageMedia,
      canHandleReports: roles.canHandleReports,
      combatView: roles.combatView,
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const squad = await db
    .select({ key: roleSquadPermissions.squadPermissionKey })
    .from(roleSquadPermissions)
    .where(eq(roleSquadPermissions.roleId, roleId));
  const explicit = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return {
    ...row,
    squadPermissions: squad.map((s) => s.key),
    permissionKeys: explicit.map((p) => p.key),
  };
}

/**
 * @param grant - a role's grant.
 * @returns every capability the role hands its members.
 */
export function roleCapabilities(grant: RoleGrant): Set<RoleCapability> {
  const out = new Set<RoleCapability>();
  for (const flag of FLAG_CAPABILITIES) {
    if (flag.granted(grant)) out.add(flag.capability);
  }
  for (const key of grant.squadPermissions) out.add(`squad:${key}`);
  for (const key of grant.permissionKeys) out.add(`perm:${key}`);
  return out;
}

function actorHolds(actor: PermissionContext | undefined, capability: RoleCapability): boolean {
  if (!actor) return false;
  if (capability.startsWith('squad:')) {
    return (actor.squadPermissions as ReadonlySet<string>).has(capability.slice('squad:'.length));
  }
  if (capability.startsWith('perm:')) {
    return (actor.permissions as ReadonlySet<string>).has(capability.slice('perm:'.length));
  }
  const flag = FLAG_CAPABILITIES.find((f) => f.capability === capability);
  return flag ? flag.held(actor) : false;
}

/**
 * Privilege ceiling: the capabilities in `capabilities` the actor does not
 * hold. The system Owner holds everything, so the result is always empty for
 * an Owner actor. API-token actors are compared against their token-narrowed
 * context, so a token can never grant more than its scopes.
 *
 * @param capabilities - what is about to be granted.
 * @param actor - the acting user's (possibly token-narrowed) context;
 *   `undefined` (no authenticated user) holds nothing.
 * @returns the offending capabilities, sorted; empty when the grant is allowed.
 */
export function capabilitiesBeyondActor(
  capabilities: Iterable<RoleCapability>,
  actor: PermissionContext | undefined,
): RoleCapability[] {
  if (actor?.isOwner) return [];
  const beyond: RoleCapability[] = [];
  for (const capability of capabilities) {
    if (!actorHolds(actor, capability)) beyond.push(capability);
  }
  return beyond.sort();
}

/** Response body for a request refused by the privilege ceiling. */
export function roleCeilingError(beyond: readonly RoleCapability[]): {
  error: 'role_exceeds_actor_permissions';
  capabilities: readonly RoleCapability[];
} {
  return { error: 'role_exceeds_actor_permissions', capabilities: beyond };
}

/**
 * Privilege ceiling for assigning an existing role: the capabilities of
 * `roleId` the actor does not hold.
 *
 * @param db - database handle.
 * @param roleId - the role about to be assigned.
 * @param actor - the acting user's (possibly token-narrowed) context;
 *   `undefined` holds nothing.
 * @returns the offending capabilities; empty when the assignment is allowed
 *   or the role does not exist (callers report a missing role themselves).
 */
export async function roleGrantBeyondActor(
  db: Pick<DatabaseClient, 'select'>,
  roleId: string,
  actor: PermissionContext | undefined,
): Promise<RoleCapability[]> {
  if (actor?.isOwner) return [];
  const grant = await loadRoleGrant(db, roleId);
  if (!grant) return [];
  return capabilitiesBeyondActor(roleCapabilities(grant), actor);
}
