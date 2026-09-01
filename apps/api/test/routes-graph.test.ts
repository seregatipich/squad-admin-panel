import { describe, expect, it, vi } from 'vitest';

vi.mock('@squad/db', () => ({
  createDatabaseClient: vi.fn(),
  servers: {},
  auditLog: {},
  schema: {},
}));

vi.mock('@squad/db/schema', () => ({
  servers: { id: 'id', status: 'status', displayName: 'displayName', slug: 'slug' },
  auditLog: { id: 'id', createdAt: 'createdAt' },
  players: { steamId64: 'steamId64' },
  roles: { id: 'id', name: 'name' },
  sessions: { id: 'id' },
  configVersions: { id: 'id' },
  serverCredentials: { id: 'id' },
  serverSettings: { id: 'id' },
  playerApiTokens: { id: 'id' },
  rolePermissions: { roleId: 'roleId' },
  roleSquadPermissions: { roleId: 'roleId' },
  panelMeta: { key: 'key' },
  vipLifecycleEvents: { eventId: 'eventId' },
  playerIpHistory: {},
  playerNameHistory: {},
  playerDiscordLinks: { playerId: 'playerId', discordUserId: 'discordUserId' },
  // issues.ts dereferences this at module scope to build its zod enum.
  ISSUE_LINK_ENTITY_TYPES: ['player', 'server', 'moderation_action', 'media_file'],
}));

vi.mock('@squad/bridge-client', () => ({
  BridgeClient: class {},
}));

vi.mock('@squad/shared-config', () => ({
  DEPOT_VOLUME_NAME: 'squad-depot',
  PANEL_CONFIGS_ROOT: '/var/lib/squad-panel/configs',
  PANEL_SAVED_ROOT: '/var/lib/squad-panel/saved',
  SERVER_IMAGE: 'squad-server:latest',
  PERMISSION_KEYS: [],
  PERMISSIONS: [],
  HOST_METRICS_STREAM: 'host:metrics',
  HEARTBEAT_PREFIX: 'worker:heartbeat:',
  ALLOWED_CONFIG_FILES: [],
  configFileClass: vi.fn(),
  isRoleColor: vi.fn(),
  isSquadPermissionKey: vi.fn(),
  SQUAD_PERMISSIONS: [],
  decodeLogEntry: vi.fn(),
  LOG_LEVELS: ['debug', 'info', 'warn', 'error'],
  sourceCode: vi.fn(),
  PANEL_LOGS_STREAM: 'panel:logs',
  SERVER_CONTAINER_PREFIX: 'squad-',
  resolveRconHost: vi.fn(),
}));

vi.mock('@squad/shared-types', () => ({
  serverCreateInput: { parse: vi.fn() },
}));

vi.mock('@squad/diag', () => ({
  Diag: class {},
}));

vi.mock('ioredis', () => ({
  default: class {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  sql: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
  ilike: vi.fn(),
  or: vi.fn(),
  like: vi.fn(),
}));

vi.mock('diff', () => ({
  createPatch: vi.fn(),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => '00000000-0000-0000-0000-000000000000'),
}));

vi.mock('fastify-plugin', () => ({
  default: (fn: unknown) => fn,
}));

vi.mock('../src/lib/admins-cfg-sync.js', () => ({
  publishAdminsCfgSyncForServer: vi.fn(),
  publishAdminsCfgSyncForAllServers: vi.fn(),
}));

vi.mock('../src/lib/rbac.js', () => ({
  loadUserPermissions: vi.fn(),
  invalidatePermissionCache: vi.fn(),
  invalidateAllPermissionCaches: vi.fn(),
  invalidatePermissionCacheForRole: vi.fn(),
}));

vi.mock('../src/lib/sessions.js', () => ({
  createSession: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllForPlayer: vi.fn(),
  tokenIdFromToken: vi.fn(),
}));

vi.mock('../src/lib/steam-profile.js', () => ({
  fetchSteamProfile: vi.fn(),
}));

vi.mock('../src/lib/first-owner.js', () => ({
  claimFirstOwner: vi.fn(),
}));

vi.mock('../src/lib/crypto.js', () => ({
  encrypt: vi.fn(),
  serialize: vi.fn(),
  decryptString: vi.fn(),
  deserialize: vi.fn(),
}));

vi.mock('../src/lib/rcon-send.js', () => ({
  rconSendOnce: vi.fn(),
}));

vi.mock('../src/lib/rcon-host.js', () => ({
  resolveRconHost: vi.fn(),
}));

vi.mock('../src/lib/auto-prune.js', () => ({
  fireAutoPrune: vi.fn(),
}));

vi.mock('../src/lib/cleanup-orphans.js', () => ({
  cleanupOrphans: vi.fn(),
}));

vi.mock('../src/lib/server-delete.js', () => ({
  softDeleteServer: vi.fn(),
}));

vi.mock('../src/lib/server-restore.js', () => ({
  restoreConfigsFromArchive: vi.fn(),
}));

vi.mock('../src/lib/audit.js', () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock('../src/lib/blame.js', () => ({
  computeBlame: vi.fn(),
}));

vi.mock('../src/lib/api-tokens.js', () => ({
  mintApiToken: vi.fn(),
  validateScopesSubset: vi.fn(),
}));

vi.mock('../src/lib/log-export.js', () => ({
  streamBundle: vi.fn(),
}));

vi.mock('../src/plugins/auth.js', () => ({
  SESSION_COOKIE: '__Host-sid',
}));

vi.mock('../src/lib/logger.js', () => ({
  als: { run: vi.fn() },
}));

import adminsCfgRoutes from '../src/routes/admins-cfg.js';
import auditRoutes from '../src/routes/audit.js';
import authRoutes from '../src/routes/auth.js';
import authBssRoutes from '../src/routes/auth-bss.js';
import authDiscordRoutes from '../src/routes/auth-discord.js';
import depotRoutes from '../src/routes/depot.js';
import hostRoutes from '../src/routes/host.js';
import hostActionsRoutes from '../src/routes/host-actions.js';
import integrationsVipRoutes from '../src/routes/integrations-vip.js';
import issuesRoutes from '../src/routes/issues.js';
import liveRoutes from '../src/routes/live.js';
import logsRoutes from '../src/routes/logs.js';
import meTokensRoutes from '../src/routes/me-tokens.js';
import permissionsRoutes from '../src/routes/permissions.js';
import playerRoutes from '../src/routes/players.js';
import roleMembersRoutes from '../src/routes/role-members.js';
import rolesRoutes from '../src/routes/roles.js';
import serverArchiveRoutes from '../src/routes/server-archive.js';
import serverConfigsRoutes from '../src/routes/server-configs.js';
import serverInstallRoutes from '../src/routes/server-install.js';
import serverLogsRoutes from '../src/routes/server-logs.js';
import serverRoutes from '../src/routes/servers.js';
import usersRoutes from '../src/routes/users.js';

describe('routes import graph', () => {
  it('admins-cfg exports a Fastify plugin', () => {
    expect(typeof adminsCfgRoutes).toBe('function');
  });

  it('audit exports a Fastify plugin', () => {
    expect(typeof auditRoutes).toBe('function');
  });

  it('auth-discord exports a Fastify plugin', () => {
    expect(typeof authDiscordRoutes).toBe('function');
  });

  it('auth-bss exports a Fastify plugin', () => {
    expect(typeof authBssRoutes).toBe('function');
  });

  it('auth exports a Fastify plugin', () => {
    expect(typeof authRoutes).toBe('function');
  });

  it('depot exports a Fastify plugin', () => {
    expect(typeof depotRoutes).toBe('function');
  });

  it('host-actions exports a Fastify plugin', () => {
    expect(typeof hostActionsRoutes).toBe('function');
  });

  it('host exports a Fastify plugin', () => {
    expect(typeof hostRoutes).toBe('function');
  });

  it('integrations-vip exports a Fastify plugin', () => {
    expect(typeof integrationsVipRoutes).toBe('function');
  });

  it('issues exports a Fastify plugin', () => {
    expect(typeof issuesRoutes).toBe('function');
  });

  it('live exports a Fastify plugin', () => {
    expect(typeof liveRoutes).toBe('function');
  });

  it('logs exports a Fastify plugin', () => {
    expect(typeof logsRoutes).toBe('function');
  });

  it('me-tokens exports a Fastify plugin', () => {
    expect(typeof meTokensRoutes).toBe('function');
  });

  it('permissions exports a Fastify plugin', () => {
    expect(typeof permissionsRoutes).toBe('function');
  });

  it('players exports a Fastify plugin', () => {
    expect(typeof playerRoutes).toBe('function');
  });

  it('role-members exports a Fastify plugin', () => {
    expect(typeof roleMembersRoutes).toBe('function');
  });

  it('roles exports a Fastify plugin', () => {
    expect(typeof rolesRoutes).toBe('function');
  });

  it('server-archive exports a Fastify plugin', () => {
    expect(typeof serverArchiveRoutes).toBe('function');
  });

  it('server-configs exports a Fastify plugin', () => {
    expect(typeof serverConfigsRoutes).toBe('function');
  });

  it('server-install exports a Fastify plugin', () => {
    expect(typeof serverInstallRoutes).toBe('function');
  });

  it('server-logs exports a Fastify plugin', () => {
    expect(typeof serverLogsRoutes).toBe('function');
  });

  it('servers exports a Fastify plugin', () => {
    expect(typeof serverRoutes).toBe('function');
  });

  it('users exports a Fastify plugin', () => {
    expect(typeof usersRoutes).toBe('function');
  });
});
