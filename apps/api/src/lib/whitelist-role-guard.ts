import type { FastifyRequest } from 'fastify';

/** The role columns the whitelist guard needs to recognise the system Owner role. */
export interface GuardedRole {
  id: string;
  name: string;
  isSystemRole: boolean;
}

/** Why a whitelist-path role write was refused, with the HTTP status to answer. */
export interface WhitelistRoleDenial {
  status: 403 | 409;
  error: 'owner_assignment_forbidden' | 'owner_role_protected' | 'role_assignment_forbidden';
}

/** True for the built-in Owner role (system role named `Owner`), matching `rbac.ts`. */
export function isOwnerRole(role: Pick<GuardedRole, 'name' | 'isSystemRole'>): boolean {
  return role.isSystemRole && role.name === 'Owner';
}

/** Whether the caller holds `user:manage_roles` (the right the role-management routes require). */
export function callerCanManageRoles(req: FastifyRequest): boolean {
  return req.user?.permissions.permissions.has('user:manage_roles') ?? false;
}

/**
 * Decides whether a whitelist path (application approval, member add, CSV
 * import) may set `targetRole` on a player currently holding `currentRole`.
 *
 * The whitelist routes are gated only on `whitelist:edit`, which every
 * panel-access role derives (`derivePanelPermissions` in `rbac.ts`), so they
 * must not become a back door around `PUT /api/v1/players/:id/role`:
 * - the Owner role is never granted (`owner_assignment_forbidden`, 403);
 * - an Owner is never demoted here (`owner_role_protected`, 409) — that stays
 *   with the role-management routes and their last-Owner checks;
 * - without `user:manage_roles` the caller may only hand out the configured
 *   whitelist role, and only to a player who holds no role or already holds
 *   it (`role_assignment_forbidden`, 403).
 *
 * @param params.canManageRoles - Whether the caller holds `user:manage_roles`.
 * @param params.targetRole - The role about to be written to the player.
 * @param params.whitelistRoleId - `panel_meta.whitelist_role_id`, or null when unset.
 * @param params.currentRole - The player's current role, or null when roleless.
 * @returns The denial to answer with, or null when the write is allowed.
 */
export function whitelistRoleWriteDenial(params: {
  canManageRoles: boolean;
  targetRole: GuardedRole;
  whitelistRoleId: string | null;
  currentRole: GuardedRole | null;
}): WhitelistRoleDenial | null {
  const { canManageRoles, targetRole, whitelistRoleId, currentRole } = params;
  if (isOwnerRole(targetRole)) return { status: 403, error: 'owner_assignment_forbidden' };
  if (currentRole && isOwnerRole(currentRole)) {
    return { status: 409, error: 'owner_role_protected' };
  }
  if (canManageRoles) return null;
  if (targetRole.id !== whitelistRoleId) return { status: 403, error: 'role_assignment_forbidden' };
  if (currentRole && currentRole.id !== targetRole.id) {
    return { status: 403, error: 'role_assignment_forbidden' };
  }
  return null;
}
