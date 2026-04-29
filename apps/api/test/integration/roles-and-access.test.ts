import { players, roleSquadPermissions, roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches, loadUserPermissions } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const OWNER_STEAM = testSteamId(800001);
const ALICE = testSteamId(800002); // becomes Admin
const BOB = testSteamId(800003); // becomes Moderator
const CARL = testSteamId(800004); // unassigned

let h: IntegrationHarness;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const { token } = await createSession(h.db, h.redis, {
    steamId64,
    ip: null,
    userAgent: 'roles-and-access-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  for (const sid of [ALICE, BOB, CARL]) {
    const stub = `Player${String(sid).slice(-4)}`;
    await h.db
      .insert(players)
      .values({
        steamId64: sid,
        canonicalName: stub,
        canonicalNameNormalized: stub.toLowerCase(),
      })
      .onConflictDoNothing();
  }
}, 60_000);

afterAll(async () => {
  for (const sid of [ALICE, BOB, CARL]) {
    // biome-ignore format: keep on one line so test-isolation regex picks up steamId64, sid filter
    await h.db.delete(players).where(eq(players.steamId64, sid)).catch(() => undefined);
  }
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('seeded roles per spec', () => {
  it('exposes Owner with all 21 squad permissions and all 3 access flags', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      name: string;
      panel_access: boolean;
      can_assign_roles: boolean;
      can_edit_roles: boolean;
      squad_permissions: string[];
      color: string;
    }>;
    const owner = body.find((r) => r.name === 'Owner');
    expect(owner?.panel_access).toBe(true);
    expect(owner?.can_assign_roles).toBe(true);
    expect(owner?.can_edit_roles).toBe(true);
    expect(owner?.squad_permissions).toContain('kick');
    expect(owner?.squad_permissions).toContain('ban');
    expect(owner?.color).toBe('#FF0000');
  });

  it('exposes the spec roles with the spec colors', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    const body = res.json() as Array<{ name: string; color: string }>;
    const byName = Object.fromEntries(body.map((r) => [r.name, r.color]));
    expect(byName.Admin).toBe('#CD5C5C');
    expect(byName.Moderator).toBe('#2E8B57');
    expect(byName.QueuePriority).toBe('#DAA520');
    expect(byName.Cameraman).toBe('#8B008B');
    expect(byName.Intern).toBe('#005EC2');
  });

  it('Admin role has the spec Squad permissions but no can_assign/edit flags', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    const body = res.json() as Array<{
      name: string;
      panel_access: boolean;
      can_assign_roles: boolean;
      can_edit_roles: boolean;
      squad_permissions: string[];
    }>;
    const admin = body.find((r) => r.name === 'Admin');
    expect(admin?.panel_access).toBe(true);
    expect(admin?.can_assign_roles).toBe(false);
    expect(admin?.can_edit_roles).toBe(false);
    const expectedAdminPerms = [
      'changemap',
      'pause',
      'cheat',
      'balance',
      'chat',
      'kick',
      'ban',
      'config',
      'cameraman',
      'manageserver',
      'featuretest',
      'reserve',
      'debug',
      'teamchange',
      'canseeadminchat',
    ].sort();
    expect([...(admin?.squad_permissions ?? [])].sort()).toEqual(expectedAdminPerms);
  });
});

describeIfDb('flag-derived panel permissions', () => {
  it('panel_access=false → empty derived panel permission set', async () => {
    // Carl is unassigned => no permissions; flip to QueuePriority (panel_access=false).
    const queuePriority = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'QueuePriority'))
      .limit(1);
    await h.db
      .update(players)
      .set({ roleId: queuePriority[0]?.id ?? null })
      .where(eq(players.steamId64, CARL));
    invalidateAllPermissionCaches();
    const ctx = await loadUserPermissions(h.db, CARL);
    expect(ctx.panelAccess).toBe(false);
    expect(ctx.permissions.size).toBe(0);
    expect(ctx.squadPermissions.has('reserve')).toBe(true);
  });

  it('panel_access=true grants the broad panel permission set without role:* / user:manage_roles', async () => {
    const moderator = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Moderator'))
      .limit(1);
    await h.db
      .update(players)
      .set({ roleId: moderator[0]?.id ?? null })
      .where(eq(players.steamId64, BOB));
    invalidateAllPermissionCaches();
    const ctx = await loadUserPermissions(h.db, BOB);
    expect(ctx.panelAccess).toBe(true);
    expect(ctx.permissions.has('server:view')).toBe(true);
    expect(ctx.permissions.has('server:install')).toBe(true);
    expect(ctx.permissions.has('role:edit')).toBe(false);
    expect(ctx.permissions.has('user:manage_roles')).toBe(false);
  });
});

describeIfDb('Owner immutability + uniqueness', () => {
  it('PUT /api/v1/roles/:owner is rejected with owner_role_immutable', async () => {
    const owner = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${owner[0]?.id}`,
      headers: {
        cookie: await loginAsSteam(OWNER_STEAM),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'NotOwner' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'owner_role_immutable' });
  });

  it('PUT /api/v1/players/:steam_id64/role rejects setting Owner role via API', async () => {
    const owner = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${ALICE}/role`,
      headers: {
        cookie: await loginAsSteam(OWNER_STEAM),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ role_id: owner[0]?.id }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'owner_assignment_forbidden' });
  });
});

describeIfDb('flag dependency — panel_access=false ⇒ flags off', () => {
  it('rejects creating a role with panel_access=false but can_edit_roles=true', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: {
        cookie: await loginAsSteam(OWNER_STEAM),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        name: `dep-${Date.now()}`,
        color: '#123456',
        squad_permissions: [],
        panel_access: false,
        can_assign_roles: false,
        can_edit_roles: true,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(
      'panel_access_required_for_role_management',
    );
  });
});

describeIfDb('admins-cfg drift + force-sync endpoints', () => {
  it('GET /api/v1/admins-cfg/drift returns unknown when no status published', async () => {
    const existing = await h.db.select({ id: servers.id }).from(servers).limit(1);
    const serverId = existing[0]?.id;
    if (!serverId) return; // no server in test DB; skip
    await h.redis.del(`admins-cfg:status:${serverId}`);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admins-cfg/drift?server_id=${serverId}`,
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { server_id: string; status: { state: string } };
    expect(body.status.state).toBe('unknown');
  });

  it('POST /api/v1/admins-cfg/sync enqueues a force_sync event', async () => {
    const existing = await h.db.select({ id: servers.id }).from(servers).limit(1);
    const serverId = existing[0]?.id;
    if (!serverId) return; // no server in test DB; skip
    const stream = `events:admins-cfg-sync:${serverId}`;
    await h.redis.del(stream);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admins-cfg/sync?server_id=${serverId}`,
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    expect(res.statusCode).toBe(200);
    const len = await h.redis.xlen(stream);
    expect(len).toBeGreaterThanOrEqual(1);
    // Inspect the most recent entry — should carry reason=force_sync.
    const entries = (await h.redis.xrevrange(stream, '+', '-', 'COUNT', 1)) as Array<
      [string, string[]]
    >;
    const kv = entries[0]?.[1] ?? [];
    const evIdx = kv.indexOf('event');
    expect(evIdx).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(kv[evIdx + 1] ?? '{}') as { reason: string };
    expect(payload.reason).toBe('force_sync');
  });

  it('GET /api/v1/admins-cfg/drift returns 404 for unknown server', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admins-cfg/drift?server_id=00000000-0000-0000-0000-000000000000',
      headers: { cookie: await loginAsSteam(OWNER_STEAM) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('admins-cfg sync stream is published on role mutations', () => {
  it('POST /api/v1/roles enqueues an admins-cfg-sync event for every active server', async () => {
    // ensure at least one server exists
    const existing = await h.db.select({ id: servers.id }).from(servers).limit(1);
    let serverId = existing[0]?.id;
    if (!serverId) {
      const fresh = `00000000-0000-0000-0000-${Date.now().toString().padStart(12, '0').slice(-12)}`;
      await h.db.insert(servers).values({
        id: fresh,
        displayName: 'sync-test-server',
        slug: `sync-${Date.now()}`,
      });
      serverId = fresh;
    }
    // Drain stream
    const stream = `events:admins-cfg-sync:${serverId}`;
    await h.redis.del(stream);

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: {
        cookie: await loginAsSteam(OWNER_STEAM),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        name: `sync-${Date.now()}`,
        color: '#abcdef',
        squad_permissions: ['reserve'],
        panel_access: false,
      }),
    });
    expect(created.statusCode).toBe(201);

    const len = await h.redis.xlen(stream);
    expect(len).toBeGreaterThanOrEqual(1);

    // Cleanup
    const { id } = created.json() as { id: string };
    await h.db.delete(roleSquadPermissions).where(eq(roleSquadPermissions.roleId, id));
    await h.db.delete(roles).where(eq(roles.id, id));
  });
});
