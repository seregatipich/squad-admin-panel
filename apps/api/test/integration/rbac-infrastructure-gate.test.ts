import { players, rolePermissions, roleSquadPermissions, roles, servers } from '@squad/db/schema';
import { PERMISSIONS, type PermissionKey } from '@squad/shared-config';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  invalidateAllPermissionCaches,
  loadUserPermissions,
  PANEL_PERMS_GATED_BY_INFRASTRUCTURE,
  PANEL_PERMS_WITH_FLAG_GATE,
} from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

/**
 * #36 findings 40 and 41: `panel_access` alone must not hand out the
 * infrastructure keys (host daemon, server install/delete/force-stop/update,
 * config and Admins.cfg edits, API-token minting), and a legacy
 * `role_permissions` row must not bypass the role's flag gates.
 */
const OWNER_STEAM = testSteamId(836001);
const PLAYER_STEAM_BASE = 836100;

const INFRASTRUCTURE_KEYS: readonly PermissionKey[] = [
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
];

let h: IntegrationHarness;
let steamSeq = 0;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function seedPlayerOnRole(roleId: string): Promise<{ playerId: string; cookie: string }> {
  steamSeq += 1;
  const steamId64 = testSteamId(PLAYER_STEAM_BASE + steamSeq);
  const name = `RbacGate${steamSeq}`;
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase(), roleId })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed player');
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'rbac-infrastructure-gate-test',
    ttlMs: 21_600_000,
  });
  return { playerId: row.id, cookie: `__Host-sid=${token}` };
}

async function createRole(values: Partial<typeof roles.$inferInsert>): Promise<string> {
  const id = uuidv7();
  await h.db.insert(roles).values({ id, name: `rbac-gate-${id}`, color: '#336699', ...values });
  return id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterEach(() => {
  invalidateAllPermissionCaches();
});

afterAll(async () => {
  await h.cleanup();
});

describe('infrastructure gate catalogue', () => {
  it('gates every infrastructure key behind can_manage_infrastructure', () => {
    expect([...PANEL_PERMS_GATED_BY_INFRASTRUCTURE].sort()).toEqual(
      [...INFRASTRUCTURE_KEYS].sort(),
    );
  });

  it('puts every dangerous catalogue key behind some role flag', () => {
    const dangerous = PERMISSIONS.filter((p) => 'dangerous' in p && p.dangerous).map((p) => p.key);
    for (const key of dangerous) expect(PANEL_PERMS_WITH_FLAG_GATE.has(key)).toBe(true);
  });
});

describeIfDb('panel_access without can_manage_infrastructure (#36 finding 40)', () => {
  it('does not grant the infrastructure keys to a panel_access-only role', async () => {
    const roleId = await createRole({ panelAccess: true });
    const { playerId } = await seedPlayerOnRole(roleId);
    const ctx = await loadUserPermissions(h.db, playerId);
    for (const key of INFRASTRUCTURE_KEYS) expect(ctx.permissions.has(key)).toBe(false);
    expect(ctx.permissions.has('server:view')).toBe(true);
    expect(ctx.permissions.has('player:view')).toBe(true);
    expect(ctx.permissions.has('config:view')).toBe(true);
  });

  it('grants them once the role carries can_manage_infrastructure', async () => {
    const roleId = await createRole({ panelAccess: true, canManageInfrastructure: true });
    const { playerId } = await seedPlayerOnRole(roleId);
    const ctx = await loadUserPermissions(h.db, playerId);
    for (const key of INFRASTRUCTURE_KEYS) expect(ctx.permissions.has(key)).toBe(true);
  });

  it('leaves the seeded Moderator without host/server-lifecycle keys and keeps Admin on them', async () => {
    const [moderator] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Moderator'), eq(roles.isSystemRole, false)));
    const [admin] = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Admin'), eq(roles.isSystemRole, false)));
    if (!moderator || !admin) throw new Error('seeded roles missing');
    const mod = await loadUserPermissions(h.db, (await seedPlayerOnRole(moderator.id)).playerId);
    const adm = await loadUserPermissions(h.db, (await seedPlayerOnRole(admin.id)).playerId);
    for (const key of INFRASTRUCTURE_KEYS) {
      expect(mod.permissions.has(key)).toBe(false);
      expect(adm.permissions.has(key)).toBe(true);
    }
  });

  it('answers 403 on the host daemon and server delete routes', async () => {
    const roleId = await createRole({ panelAccess: true });
    const { cookie } = await seedPlayerOnRole(roleId);
    const serverId = uuidv7();
    await h.db
      .insert(servers)
      .values({ id: serverId, displayName: 'RBAC gate server', slug: `rbac-gate-${serverId}` });

    const restart = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(restart.statusCode).toBe(403);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(403);
    const [stillThere] = await h.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(stillThere).toBeDefined();
  });
});

describeIfDb('roles API — can_manage_infrastructure', () => {
  it('creates, lists and updates the flag, and the grant follows it', async () => {
    const cookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie },
      payload: { name: `InfraRole${Date.now()}`, color: '#336699', panel_access: true },
    });
    expect(created.statusCode).toBe(201);
    const role = created.json() as { id: string; can_manage_infrastructure: boolean };
    expect(role.can_manage_infrastructure).toBe(false);
    const { playerId } = await seedPlayerOnRole(role.id);
    expect((await loadUserPermissions(h.db, playerId)).permissions.has('host:manage')).toBe(false);

    const updated = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${role.id}`,
      headers: { cookie },
      payload: { can_manage_infrastructure: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: role.id, can_manage_infrastructure: true });
    expect((await loadUserPermissions(h.db, playerId)).permissions.has('host:manage')).toBe(true);

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/roles', headers: { cookie } });
    const row = (listed.json() as Array<{ id: string; can_manage_infrastructure: boolean }>).find(
      (r) => r.id === role.id,
    );
    expect(row?.can_manage_infrastructure).toBe(true);
  });
});

describeIfDb('legacy role_permissions rows (#36 finding 41)', () => {
  it('do not bypass the flag gates of a role without the matching flags', async () => {
    const roleId = await createRole({ panelAccess: false });
    const legacy: PermissionKey[] = [
      'user:manage_roles',
      'role:edit',
      'integration:manage',
      'player:view_ips',
      'mod:ban_perm',
      'mod:kick',
      'host:manage',
      'server:delete',
    ];
    await h.db
      .insert(rolePermissions)
      .values(legacy.map((permissionKey) => ({ roleId, permissionKey })));
    const { playerId } = await seedPlayerOnRole(roleId);
    const ctx = await loadUserPermissions(h.db, playerId);
    for (const key of legacy) expect(ctx.permissions.has(key)).toBe(false);
  });

  it('still honour a gated key once the role holds its flag', async () => {
    const roleId = await createRole({ canManageInfrastructure: true });
    await h.db.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: 'ban' });
    await h.db.insert(rolePermissions).values([
      { roleId, permissionKey: 'host:manage' },
      { roleId, permissionKey: 'mod:ban_perm' },
      { roleId, permissionKey: 'server:view' },
    ]);
    const { playerId } = await seedPlayerOnRole(roleId);
    const ctx = await loadUserPermissions(h.db, playerId);
    expect([...ctx.permissions].sort()).toEqual(['host:manage', 'mod:ban_perm', 'server:view']);
  });
});
