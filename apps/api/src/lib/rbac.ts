import type { DatabaseClient } from '@squad/db';
import { players, rolePermissions, roleSquadPermissions, roles } from '@squad/db/schema';
import {
  isPermissionKey,
  PERMISSION_KEYS,
  type PermissionKey,
  SQUAD_PERMISSION_KEYS,
  type SquadPermissionKey,
} from '@squad/shared-config';
import { eq, sql } from 'drizzle-orm';
import { intersectScopes } from './api-tokens.js';

export interface PermissionContext {
  permissions: Set<PermissionKey>;
  squadPermissions: Set<SquadPermissionKey>;
  roleId: string | null;
  roleName: string | null;
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
  isOwner: boolean;
}

/**
 * Process-local permission cache keyed by player id. Entries live {@link TTL_MS};
 * changes made outside this process (workers editing `players.role_id`) are
 * therefore picked up within that window. Bounded twice so it cannot grow with
 * every player who ever logged in: expired entries are swept when an entry is
 * stored, and past {@link PERMISSION_CACHE_MAX_ENTRIES} the oldest entry is
 * evicted. Every store re-inserts its key, so Map iteration order (insertion
 * order) is also expiry order and both sweeps stop at the first live entry.
 */
const cache = new Map<string, { value: PermissionContext; expiresAt: number }>();
const TTL_MS = 30_000;

/** Upper bound on cached permission contexts. */
export const PERMISSION_CACHE_MAX_ENTRIES = 5_000;

function cachePermissions(playerId: string, value: PermissionContext): void {
  const now = Date.now();
  cache.delete(playerId);
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now && cache.size < PERMISSION_CACHE_MAX_ENTRIES) break;
    cache.delete(key);
  }
  cache.set(playerId, { value, expiresAt: now + TTL_MS });
}

/** Number of cached permission contexts; exposed for tests and diagnostics. */
export function permissionCacheSize(): number {
  return cache.size;
}

const PANEL_PERMS_GATED_BY_ASSIGN: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'user:manage_roles',
]);
const PANEL_PERMS_GATED_BY_EDIT: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'role:create',
  'role:edit',
  'role:delete',
]);
/**
 * Automation rules run RCON actions as the system actor on every server
 * (#111), so `trigger:edit` is never handed to every `panel_access` user.
 * Role editors keep it (the rules used to be gated by `role:edit`); any other
 * role gets it only through an explicit `role_permissions` row, and an API
 * token only when `trigger:edit` itself is a delegated scope.
 */
const PANEL_PERMS_GATED_BY_TRIGGER_EDIT: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'trigger:edit',
]);
/**
 * Message templates were edited under `role:edit` before they had their own
 * key, so a role holds `message_template:manage` implicitly only while it may
 * edit roles; any other role gets it through an explicit `role_permissions`
 * grant, without receiving role management with it.
 */
const PANEL_PERMS_GATED_BY_EDIT_OR_GRANT: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'message_template:manage',
]);
const PANEL_PERMS_GATED_BY_INTEGRATIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'integration:manage',
]);
const PANEL_PERMS_GATED_BY_VIEW_IPS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'player:view_ips',
]);
// Tuning alt detection (weights, thresholds, ignored IP ranges) can switch a
// panel-wide security check off, so IP-history read access alone must not
// grant it: it takes both `can_view_ips` and `can_edit_roles`. Kept out of the
// two sets above so token narrowing of those flags is unchanged.
const PANEL_PERMS_GATED_BY_VIEW_IPS_AND_EDIT: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'player:manage_alt_detection',
]);
const PANEL_PERMS_GATED_BY_SQUAD_KICK: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'mod:kick',
  'mod:warn',
]);
const PANEL_PERMS_GATED_BY_SQUAD_BAN: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'mod:ban_temp',
  'mod:ban_perm',
  'mod:unban',
]);
/**
 * Keys that change the host or the servers' files rather than moderate
 * players: the privileged host daemon, the server lifecycle, config and
 * Admins.cfg writes, and API-token minting. `panel_access` alone does not
 * grant them; the role also needs `can_manage_infrastructure` (#36).
 */
export const PANEL_PERMS_GATED_BY_INFRASTRUCTURE: ReadonlySet<PermissionKey> =
  new Set<PermissionKey>([
    'host:manage',
    'server:install',
    'server:delete',
    'server:force_stop',
    'server:update',
    'config:edit',
    'config:rollback',
    'admin_group:edit',
    'api_token:create',
    'backup:restore',
  ]);

/**
 * Every key that needs a role flag on top of `panel_access`. Each `dangerous`
 * catalogue key must be in here; `rbac-infrastructure-gate.test.ts` fails when
 * a new dangerous key is added without a gate.
 */
export const PANEL_PERMS_WITH_FLAG_GATE: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  ...PANEL_PERMS_GATED_BY_ASSIGN,
  ...PANEL_PERMS_GATED_BY_EDIT,
  ...PANEL_PERMS_GATED_BY_TRIGGER_EDIT,
  ...PANEL_PERMS_GATED_BY_EDIT_OR_GRANT,
  ...PANEL_PERMS_GATED_BY_INTEGRATIONS,
  ...PANEL_PERMS_GATED_BY_VIEW_IPS,
  ...PANEL_PERMS_GATED_BY_VIEW_IPS_AND_EDIT,
  ...PANEL_PERMS_GATED_BY_SQUAD_KICK,
  ...PANEL_PERMS_GATED_BY_SQUAD_BAN,
  ...PANEL_PERMS_GATED_BY_INFRASTRUCTURE,
]);

const ALL_PANEL_PERMS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(PERMISSION_KEYS);

/** The role flags {@link keyPassesFlagGates} checks a key against. */
interface RoleFlagGates {
  canAssignRoles: boolean;
  canEditRoles: boolean;
  canManageIntegrations: boolean;
  canViewIps: boolean;
  canManageInfrastructure: boolean;
  squadPermissions: ReadonlySet<string>;
}

/**
 * Whether a role's flags allow it to hold `key` at all, whatever the source
 * of the key (derived from `panel_access` or an explicit `role_permissions`
 * row).
 *
 * The live-Squad gate closes the RBAC gap where `mod:kick`/`mod:warn`/
 * `mod:ban_temp`/`mod:ban_perm`/`mod:unban` would otherwise be handed to
 * every `panel_access` user: those five keys additionally require the
 * role's live-Squad `kick`/`ban` permission (`role_squad_permissions`),
 * mirroring the enforcement already applied to `POST
 * /api/v1/external-bans` (`localBanGuard` in `external-bans.ts`).
 */
function keyPassesFlagGates(key: PermissionKey, flags: RoleFlagGates): boolean {
  if (PANEL_PERMS_GATED_BY_ASSIGN.has(key) && !flags.canAssignRoles) return false;
  if (PANEL_PERMS_GATED_BY_EDIT.has(key) && !flags.canEditRoles) return false;
  if (PANEL_PERMS_GATED_BY_TRIGGER_EDIT.has(key) && !flags.canEditRoles) return false;
  if (PANEL_PERMS_GATED_BY_EDIT_OR_GRANT.has(key) && !flags.canEditRoles) return false;
  if (PANEL_PERMS_GATED_BY_INTEGRATIONS.has(key) && !flags.canManageIntegrations) return false;
  if (PANEL_PERMS_GATED_BY_VIEW_IPS.has(key) && !flags.canViewIps) return false;
  if (
    PANEL_PERMS_GATED_BY_VIEW_IPS_AND_EDIT.has(key) &&
    !(flags.canViewIps && flags.canEditRoles)
  ) {
    return false;
  }
  if (PANEL_PERMS_GATED_BY_SQUAD_KICK.has(key) && !flags.squadPermissions.has('kick')) {
    return false;
  }
  if (PANEL_PERMS_GATED_BY_SQUAD_BAN.has(key) && !flags.squadPermissions.has('ban')) return false;
  if (PANEL_PERMS_GATED_BY_INFRASTRUCTURE.has(key) && !flags.canManageInfrastructure) {
    return false;
  }
  return true;
}

/**
 * Derives the panel permission keys a role grants: every catalogue key for
 * Owner, nothing without `panel_access`, otherwise every key that passes
 * {@link keyPassesFlagGates}.
 */
function derivePanelPermissions(
  panelAccess: boolean,
  isOwner: boolean,
  flags: RoleFlagGates,
): Set<PermissionKey> {
  if (isOwner) return new Set(ALL_PANEL_PERMS);
  if (!panelAccess) return new Set();
  const out = new Set<PermissionKey>();
  for (const key of ALL_PANEL_PERMS) {
    if (keyPassesFlagGates(key, flags)) out.add(key);
  }
  return out;
}

interface RoleContextRow extends Record<string, unknown> {
  role_id: string | null;
  role_name: string | null;
  is_system_role: boolean | null;
  panel_access: boolean | null;
  can_view_ips: boolean | null;
  can_assign_roles: boolean | null;
  can_edit_roles: boolean | null;
  can_manage_issues: boolean | null;
  can_manage_ban_sources: boolean | null;
  can_manage_integrations: boolean | null;
  can_manage_clans: boolean | null;
  can_manage_economy: boolean | null;
  can_manage_media: boolean | null;
  can_handle_reports: boolean | null;
  can_manage_infrastructure: boolean | null;
  combat_view: boolean | null;
  squad_permissions: string[] | null;
}

export async function loadUserPermissions(
  db: DatabaseClient,
  playerId: string,
): Promise<PermissionContext> {
  const hit = cache.get(playerId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) cache.delete(playerId);

  const rows = await db.execute<RoleContextRow>(sql`
    SELECT
      r.id   AS role_id,
      r.name AS role_name,
      r.is_system_role,
      r.panel_access,
      r.can_view_ips,
      r.can_assign_roles,
      r.can_edit_roles,
      r.can_manage_issues,
      r.can_manage_ban_sources,
      r.can_manage_integrations,
      r.can_manage_clans,
      r.can_manage_economy,
      r.can_manage_media,
      r.can_handle_reports,
      r.can_manage_infrastructure,
      r.combat_view,
      COALESCE(
        (SELECT array_agg(rsp.squad_permission_key ORDER BY rsp.squad_permission_key)
         FROM role_squad_permissions rsp WHERE rsp.role_id = r.id),
        ARRAY[]::text[]
      ) AS squad_permissions
    FROM players p
    LEFT JOIN roles r
      ON r.id = p.role_id
     AND (p.role_expires_at IS NULL OR p.role_expires_at > now())
    WHERE p.id = ${playerId}
    LIMIT 1
  `);
  const row = (rows as unknown as RoleContextRow[])[0];

  if (!row || !row.role_id) {
    const empty: PermissionContext = {
      permissions: new Set(),
      squadPermissions: new Set(),
      roleId: null,
      roleName: null,
      panelAccess: false,
      canViewIps: false,
      canAssignRoles: false,
      canEditRoles: false,
      canManageIssues: false,
      canManageBanSources: false,
      canManageIntegrations: false,
      canManageClans: false,
      canManageEconomy: false,
      canManageMedia: false,
      canHandleReports: false,
      combatView: false,
      isOwner: false,
    };
    cachePermissions(playerId, empty);
    return empty;
  }

  const explicit = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, row.role_id));

  const value = buildRolePermissionContext(
    row.role_id,
    {
      name: row.role_name ?? '',
      isSystemRole: row.is_system_role ?? false,
      panelAccess: row.panel_access ?? false,
      canViewIps: row.can_view_ips ?? false,
      canAssignRoles: row.can_assign_roles ?? false,
      canEditRoles: row.can_edit_roles ?? false,
      canManageIssues: row.can_manage_issues ?? false,
      canManageBanSources: row.can_manage_ban_sources ?? false,
      canManageIntegrations: row.can_manage_integrations ?? false,
      canManageClans: row.can_manage_clans ?? false,
      canManageEconomy: row.can_manage_economy ?? false,
      canManageMedia: row.can_manage_media ?? false,
      canHandleReports: row.can_handle_reports ?? false,
      canManageInfrastructure: row.can_manage_infrastructure ?? false,
      combatView: row.combat_view ?? false,
      squadPermissions: row.squad_permissions ?? [],
    },
    explicit.map((entry) => entry.key),
  );
  cachePermissions(playerId, value);
  return value;
}

/**
 * The grant-bearing columns of a `roles` row plus its live-Squad permissions
 * (`role_squad_permissions`). A drizzle `select()` of `roles` satisfies every
 * field but `squadPermissions`.
 */
export interface RoleGrantDefinition {
  name: string;
  isSystemRole: boolean;
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
  canManageInfrastructure: boolean;
  combatView: boolean;
  squadPermissions: readonly string[];
}

/**
 * Derives the permission context every holder of a role receives — the same
 * derivation {@link loadUserPermissions} applies to a player's live role, so
 * callers can evaluate a role that is only proposed (e.g. the result of an
 * edit that has not been written yet).
 *
 * @param roleId - The role's id, copied into the context.
 * @param role - The role's flags and live-Squad permissions.
 * @param explicitKeys - The role's `role_permissions` keys; unknown keys are ignored.
 * @returns A fresh context; nothing is cached.
 */
export function buildRolePermissionContext(
  roleId: string,
  role: RoleGrantDefinition,
  explicitKeys: readonly string[],
): PermissionContext {
  const isOwner = role.name === 'Owner' && role.isSystemRole;
  const panelAccess = isOwner || role.panelAccess;
  const canViewIps = isOwner || role.canViewIps;
  const canAssignRoles = isOwner || role.canAssignRoles;
  const canEditRoles = isOwner || role.canEditRoles;
  const canManageIntegrations = isOwner || role.canManageIntegrations;
  const squadPermissions = isOwner
    ? new Set<SquadPermissionKey>(SQUAD_PERMISSION_KEYS)
    : new Set<SquadPermissionKey>((role.squadPermissions as SquadPermissionKey[]).filter(Boolean));

  const flags: RoleFlagGates = {
    canAssignRoles,
    canEditRoles,
    canManageIntegrations,
    canViewIps,
    canManageInfrastructure: isOwner || role.canManageInfrastructure,
    squadPermissions,
  };

  const permissions = derivePanelPermissions(panelAccess, isOwner, flags);
  // Explicit rows are legacy (no route writes them; migration 0122 wiped the
  // stored ones) and pass the same flag gates as the derived set, so a stray
  // row can never grant a key the role's flags withhold (#36).
  for (const key of explicitKeys) {
    if (isPermissionKey(key) && keyPassesFlagGates(key, flags)) permissions.add(key);
  }

  return {
    permissions,
    squadPermissions,
    roleId,
    roleName: role.name,
    panelAccess,
    canViewIps,
    canAssignRoles,
    canEditRoles,
    canManageIssues: isOwner || role.canManageIssues,
    canManageBanSources: isOwner || (panelAccess && role.canManageBanSources),
    canManageIntegrations,
    canManageClans: isOwner || role.canManageClans,
    canManageEconomy: isOwner || (panelAccess && role.canManageEconomy),
    canManageMedia: isOwner || (panelAccess && role.canManageMedia),
    canHandleReports: isOwner || role.canHandleReports,
    combatView: isOwner || (panelAccess && role.combatView),
    isOwner,
  };
}

/**
 * Loads the permission context a role grants its holders, uncached.
 *
 * @param db - Database client.
 * @param roleId - The role to evaluate.
 * @returns The context, or `null` when the role does not exist.
 */
export async function loadRolePermissions(
  db: DatabaseClient,
  roleId: string,
): Promise<PermissionContext | null> {
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) return null;
  const squad = await db
    .select({ key: roleSquadPermissions.squadPermissionKey })
    .from(roleSquadPermissions)
    .where(eq(roleSquadPermissions.roleId, roleId));
  const explicit = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return buildRolePermissionContext(
    roleId,
    { ...role, squadPermissions: squad.map((entry) => entry.key) },
    explicit.map((entry) => entry.key),
  );
}

const HIERARCHY_FLAGS = [
  ['isOwner', 'owner'],
  ['panelAccess', 'panel_access'],
  ['canViewIps', 'can_view_ips'],
  ['canAssignRoles', 'can_assign_roles'],
  ['canEditRoles', 'can_edit_roles'],
  ['canManageIssues', 'can_manage_issues'],
  ['canManageBanSources', 'can_manage_ban_sources'],
  ['canManageIntegrations', 'can_manage_integrations'],
  ['canManageClans', 'can_manage_clans'],
  ['canManageEconomy', 'can_manage_economy'],
  ['canManageMedia', 'can_manage_media'],
  ['canHandleReports', 'can_handle_reports'],
  ['combatView', 'combat_view'],
] as const satisfies ReadonlyArray<readonly [keyof PermissionContext, string]>;

/**
 * Lists every grant `target` carries that `actor` lacks — the role-hierarchy
 * check behind role assignment and role editing (#30): a non-Owner may only
 * hand out, edit or take away a role that fits entirely inside their own
 * permissions, so no chain of assignments or edits can widen what they hold.
 *
 * @param actor - The acting user's context (token-narrowed when applicable).
 * @param target - The role's context, e.g. from {@link loadRolePermissions}.
 * @returns Stable identifiers of the missing grants (`can_view_ips`,
 *   `permission:role:edit`, `squad:ban`, …); empty when `target` ⊆ `actor`.
 */
export function grantsBeyond(actor: PermissionContext, target: PermissionContext): string[] {
  const missing: string[] = [];
  for (const [field, label] of HIERARCHY_FLAGS) {
    if (target[field] && !actor[field]) missing.push(label);
  }
  for (const key of target.permissions) {
    if (!actor.permissions.has(key)) missing.push(`permission:${key}`);
  }
  for (const key of target.squadPermissions) {
    if (!actor.squadPermissions.has(key)) missing.push(`squad:${key}`);
  }
  return missing;
}

/**
 * Narrows a token owner's live role context to what an API token delegates
 * (issue #7). The effective permission set is `role ∩ token.scopes`
 * (`intersectScopes`); every other capability in the context is derived from
 * that narrowed set rather than copied from the role, because ~70 route
 * guards authorise on these fields instead of `config.permissions`:
 *
 * - a role flag that `derivePanelPermissions` maps onto catalogue keys
 *   survives only when the token was delegated every one of those keys
 *   (`canAssignRoles` ← `user:manage_roles`, `canEditRoles` ←
 *   `role:create`+`role:edit`+`role:delete`, `canManageIntegrations` ←
 *   `integration:manage`, `canViewIps` ← `player:view_ips`);
 * - live-Squad `kick` survives only with `mod:kick`+`mod:warn`, and `ban`
 *   only with `mod:ban_temp`+`mod:ban_perm`+`mod:unban`; every other Squad
 *   permission (`chat`, `changemap`, …) has no catalogue key, so a token
 *   never carries it;
 * - flags with no catalogue key (`isOwner`, `canManageIssues`,
 *   `canManageBanSources`, `canManageClans`, `canManageEconomy`,
 *   `canManageMedia`, `canHandleReports`, `combatView`) are never delegated;
 * - `panelAccess` survives only while the token carries at least one
 *   effective scope, so a `scopes: []` introspection token reaches `/me` but
 *   no `panel_access`-guarded route.
 *
 * A flag is only ever narrowed, never raised: each result is ANDed with the
 * role's own value.
 *
 * @param role - The owner's context from {@link loadUserPermissions}.
 * @param scopes - The token's stored `player_api_tokens.scopes`.
 * @returns A new context; `role` is not mutated (it is the shared cache entry).
 */
export function narrowToTokenScopes(
  role: PermissionContext,
  scopes: readonly string[],
): PermissionContext {
  const permissions = intersectScopes(scopes, role.permissions);
  const delegates = (keys: ReadonlySet<PermissionKey>): boolean => {
    for (const key of keys) if (!permissions.has(key)) return false;
    return true;
  };
  const squadPermissions = new Set<SquadPermissionKey>();
  if (role.squadPermissions.has('kick') && delegates(PANEL_PERMS_GATED_BY_SQUAD_KICK)) {
    squadPermissions.add('kick');
  }
  if (role.squadPermissions.has('ban') && delegates(PANEL_PERMS_GATED_BY_SQUAD_BAN)) {
    squadPermissions.add('ban');
  }
  return {
    permissions,
    squadPermissions,
    roleId: role.roleId,
    roleName: role.roleName,
    panelAccess: role.panelAccess && permissions.size > 0,
    canViewIps: role.canViewIps && delegates(PANEL_PERMS_GATED_BY_VIEW_IPS),
    canAssignRoles: role.canAssignRoles && delegates(PANEL_PERMS_GATED_BY_ASSIGN),
    canEditRoles: role.canEditRoles && delegates(PANEL_PERMS_GATED_BY_EDIT),
    canManageIssues: false,
    canManageBanSources: false,
    canManageIntegrations:
      role.canManageIntegrations && delegates(PANEL_PERMS_GATED_BY_INTEGRATIONS),
    canManageClans: false,
    canManageEconomy: false,
    canManageMedia: false,
    canHandleReports: false,
    combatView: false,
    isOwner: false,
  };
}

export function invalidatePermissionCache(playerId: string): void {
  cache.delete(playerId);
}

export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void> {
  const rows = await db.select({ id: players.id }).from(players).where(eq(players.roleId, roleId));
  for (const r of rows) cache.delete(r.id);
}

export function invalidateAllPermissionCaches(): void {
  cache.clear();
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) if (!ctx.permissions.has(key)) return false;
  return true;
}
