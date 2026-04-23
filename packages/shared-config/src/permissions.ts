export const PERMISSION_KEYS = [
  'server:view',
  'server:create',
  'server:edit',
  'server:delete',
  'server:start',
  'server:stop',
  'server:restart',
  'server:install',
  'server:update',
  'server:config:write',
  'server:config:history',

  'player:view',
  'player:view_ips',
  'player:view_eos_id',
  'player:view_steam_id',

  'audit:view',

  'user:view',
  'user:create',
  'user:edit',
  'user:delete',

  'role:manage',
  'permission:manage',

  'host:view',
  'host:metrics',
  'host:bridge_control',

  'org:view',
  'org:edit',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_KEY_SET: ReadonlySet<PermissionKey> = new Set(PERMISSION_KEYS);

export function isPermissionKey(x: string): x is PermissionKey {
  return PERMISSION_KEY_SET.has(x as PermissionKey);
}

export const ROLE_CLEARANCE = {
  OWNER: 1000,
  SENIOR_ADMIN: 750,
  ADMIN: 500,
  VIEWER: 100,
} as const;

export type RoleName = 'Owner' | 'Senior Admin' | 'Admin' | 'Viewer';

export const SYSTEM_ROLE_PERMISSIONS: Record<RoleName, readonly PermissionKey[]> = {
  Owner: PERMISSION_KEYS,
  'Senior Admin': [
    'server:view',
    'server:create',
    'server:edit',
    'server:start',
    'server:stop',
    'server:restart',
    'server:install',
    'server:update',
    'server:config:write',
    'server:config:history',
    'player:view',
    'player:view_ips',
    'player:view_eos_id',
    'player:view_steam_id',
    'audit:view',
    'host:view',
    'host:metrics',
    'user:view',
    'org:view',
  ],
  Admin: [
    'server:view',
    'server:start',
    'server:stop',
    'server:restart',
    'server:config:history',
    'player:view',
    'player:view_eos_id',
    'player:view_steam_id',
    'host:view',
    'host:metrics',
    'org:view',
  ],
  Viewer: [
    'server:view',
    'server:config:history',
    'player:view',
    'audit:view',
    'host:view',
    'org:view',
  ],
};

export const SYSTEM_ROLE_CLEARANCE: Record<RoleName, number> = {
  Owner: ROLE_CLEARANCE.OWNER,
  'Senior Admin': ROLE_CLEARANCE.SENIOR_ADMIN,
  Admin: ROLE_CLEARANCE.ADMIN,
  Viewer: ROLE_CLEARANCE.VIEWER,
};
