/**
 * Role-hierarchy guards for the routes that change who holds which role
 * (`PUT/DELETE /api/v1/players/:playerId/role`, `/api/v1/roles/:id/members*`)
 * and what a role grants (`POST/PUT/DELETE /api/v1/roles*`). Issue #30
 * (findings #233, #267): `user:manage_roles` and `role:edit` alone let their
 * holder assign themselves — or edit their own role into — any grant they did
 * not have, and strip the Owner role from other Owners.
 *
 * The rule, for every actor except an Owner: a role may only be handed out,
 * taken away, created, edited or deleted when it fits entirely inside the
 * actor's own permissions ({@link grantsBeyond}), and the actor may never
 * change their own role assignment or edit the role they hold.
 */
import type { DatabaseClient } from '@squad/db';
import { players } from '@squad/db/schema';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { grantsBeyond, loadRolePermissions, type PermissionContext } from './rbac.js';

/** The acting user as the auth plugin attaches it to `req.user`. */
export interface RoleActor {
  playerId: string;
  permissions: PermissionContext;
}

/** A refused role change: the 403 error code plus the grants that tripped it. */
export interface RoleHierarchyRefusal {
  error:
    | 'cannot_change_own_role'
    | 'cannot_edit_own_role'
    | 'role_exceeds_actor_permissions'
    | 'target_outranks_actor';
  missing?: string[];
  /** Same list as `missing`, under the name the privilege-ceiling refusals (`role-guards.ts`) use. */
  capabilities?: string[];
}

/**
 * Checks that `actor` may move `playerIds` onto `newRoleId` (`null` removes
 * their role). Refused when a non-Owner actor is among `playerIds`, when the
 * new role grants more than the actor holds, or when any of the players'
 * current roles does — the last one is what stops a non-Owner from demoting an
 * Owner or anyone else above them.
 *
 * @param db - Database client.
 * @param actor - `req.user`; `undefined` is refused (fail closed).
 * @param change - The players being changed and the role they get.
 * @returns `null` when allowed, otherwise the refusal to send with a 403.
 */
export async function checkRoleAssignment(
  db: DatabaseClient,
  actor: RoleActor | undefined,
  change: { playerIds: readonly string[]; newRoleId: string | null },
): Promise<RoleHierarchyRefusal | null> {
  if (!actor) return { error: 'role_exceeds_actor_permissions' };
  if (actor.permissions.isOwner) return null;
  if (change.playerIds.includes(actor.playerId)) return { error: 'cannot_change_own_role' };

  if (change.newRoleId !== null) {
    const refusal = await checkRoleWithinActor(db, actor, change.newRoleId);
    if (refusal) return refusal;
  }

  if (change.playerIds.length === 0) return null;
  const current = await db
    .selectDistinct({ roleId: players.roleId })
    .from(players)
    .where(and(inArray(players.id, [...change.playerIds]), isNotNull(players.roleId)));
  for (const { roleId } of current) {
    if (roleId === null || roleId === change.newRoleId) continue;
    const role = await loadRolePermissions(db, roleId);
    if (!role) continue;
    const missing = grantsBeyond(actor.permissions, role);
    if (missing.length > 0) return { error: 'target_outranks_actor', missing };
  }
  return null;
}

/**
 * Checks that the existing role `roleId` fits inside a non-Owner actor's own
 * permissions — the precondition for assigning, editing or deleting it.
 *
 * @param db - Database client.
 * @param actor - `req.user`; `undefined` is refused (fail closed).
 * @param roleId - The role; a missing role passes (callers answer 404 themselves).
 * @returns `null` when allowed, otherwise the refusal to send with a 403.
 */
export async function checkRoleWithinActor(
  db: DatabaseClient,
  actor: RoleActor | undefined,
  roleId: string,
): Promise<RoleHierarchyRefusal | null> {
  if (!actor) return { error: 'role_exceeds_actor_permissions' };
  if (actor.permissions.isOwner) return null;
  const role = await loadRolePermissions(db, roleId);
  if (!role) return null;
  return checkGrantsWithinActor(actor, role);
}

/**
 * Checks that a role context — typically one that is only proposed, built
 * with `buildRolePermissionContext` from a create/edit body — fits inside a
 * non-Owner actor's own permissions.
 *
 * @param actor - `req.user`; `undefined` is refused (fail closed).
 * @param role - The role's derived context.
 * @returns `null` when allowed, otherwise the refusal to send with a 403.
 */
export function checkGrantsWithinActor(
  actor: RoleActor | undefined,
  role: PermissionContext,
): RoleHierarchyRefusal | null {
  if (!actor) return { error: 'role_exceeds_actor_permissions' };
  if (actor.permissions.isOwner) return null;
  const missing = grantsBeyond(actor.permissions, role);
  return missing.length > 0
    ? { error: 'role_exceeds_actor_permissions', missing, capabilities: missing }
    : null;
}
