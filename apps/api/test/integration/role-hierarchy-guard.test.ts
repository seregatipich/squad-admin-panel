/**
 * Issue #30 (findings #233, #267): a non-Owner holding `user:manage_roles` or
 * `role:edit` must not be able to widen their own grants or act on a role —
 * or a role holder — above them.
 */
import { players, roleSquadPermissions, roles } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const OWNER_STEAM = testSteamId(830001);
const SECOND_OWNER_STEAM = testSteamId(830002);
const ASSIGNER_STEAM = testSteamId(830003);
const EDITOR_STEAM = testSteamId(830004);
const TARGET_STEAM = testSteamId(830005);
const ALL_STEAMS = [OWNER_STEAM, SECOND_OWNER_STEAM, ASSIGNER_STEAM, EDITOR_STEAM, TARGET_STEAM];

let h: IntegrationHarness;
let ownerRoleId: string;
let assignerRoleId: string;
let editorRoleId: string;
let wideRoleId: string;
let narrowRoleId: string;
const playerIdBySteam = new Map<bigint, string>();

function pid(steamId64: bigint): string {
  const id = playerIdBySteam.get(steamId64);
  if (!id) throw new Error(`player ${steamId64} not seeded`);
  return id;
}

async function loginAs(steamId64: bigint): Promise<string> {
  const { token } = await createSession(h.db, h.redis, {
    playerId: pid(steamId64),
    ip: null,
    userAgent: 'role-hierarchy-guard-test',
    ttlMs: 3_600_000,
  });
  return `__Host-sid=${token}`;
}

async function insertRole(values: Partial<typeof roles.$inferInsert>): Promise<string> {
  const id = uuidv7();
  await h.db.insert(roles).values({
    id,
    name: `HierarchyTest${id.slice(-8)}`,
    color: 'emerald',
    isSystemRole: false,
    ...values,
  });
  return id;
}

async function roleOf(steamId64: bigint): Promise<string | null> {
  const [row] = await h.db
    .select({ roleId: players.roleId })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  return row?.roleId ?? null;
}

async function resetRoles(): Promise<void> {
  const assignments: Array<[bigint, string | null]> = [
    [OWNER_STEAM, ownerRoleId],
    [SECOND_OWNER_STEAM, ownerRoleId],
    [ASSIGNER_STEAM, assignerRoleId],
    [EDITOR_STEAM, editorRoleId],
    [TARGET_STEAM, null],
  ];
  for (const [steamId, roleId] of assignments) {
    await h.db.update(players).set({ roleId }).where(eq(players.steamId64, steamId));
  }
  await h.db
    .update(roles)
    .set({ canViewIps: false, canAssignRoles: false })
    .where(eq(roles.id, editorRoleId));
  invalidateAllPermissionCaches();
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  const [owner] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!owner) throw new Error('Owner role missing');
  ownerRoleId = owner.id;

  assignerRoleId = await insertRole({ panelAccess: true, canAssignRoles: true });
  editorRoleId = await insertRole({ panelAccess: true, canEditRoles: true });
  wideRoleId = await insertRole({
    panelAccess: true,
    canViewIps: true,
    canEditRoles: true,
    canManageIntegrations: true,
  });
  await h.db.insert(roleSquadPermissions).values({ roleId: wideRoleId, squadPermissionKey: 'ban' });
  narrowRoleId = await insertRole({ panelAccess: true });

  for (const steamId64 of ALL_STEAMS) {
    const name = `Hierarchy${String(steamId64).slice(-6)}`;
    const [row] = await h.db
      .insert(players)
      .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() })
      .onConflictDoUpdate({ target: players.steamId64, set: { canonicalName: name } })
      .returning({ id: players.id });
    if (!row) throw new Error('player seed failed');
    playerIdBySteam.set(steamId64, row.id);
  }
}, 60_000);

beforeEach(resetRoles);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

describeIfDb('PUT/DELETE /api/v1/players/:playerId/role — role hierarchy (#233)', () => {
  it('refuses a non-Owner assigning themselves a wider role', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${pid(ASSIGNER_STEAM)}/role`,
      headers: { cookie: await loginAs(ASSIGNER_STEAM) },
      payload: { role_id: wideRoleId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'cannot_change_own_role' });
    expect(await roleOf(ASSIGNER_STEAM)).toBe(assignerRoleId);
  });

  it('refuses a non-Owner handing another player a role wider than their own', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${pid(TARGET_STEAM)}/role`,
      headers: { cookie: await loginAs(ASSIGNER_STEAM) },
      payload: { role_id: wideRoleId },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; missing: string[] };
    expect(body.error).toBe('role_exceeds_actor_permissions');
    expect(body.missing).toEqual(expect.arrayContaining(['can_view_ips', 'squad:ban']));
    expect(await roleOf(TARGET_STEAM)).toBeNull();
  });

  it('refuses a non-Owner replacing or removing another Owner’s role', async () => {
    const cookie = await loginAs(ASSIGNER_STEAM);
    const replace = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${pid(SECOND_OWNER_STEAM)}/role`,
      headers: { cookie },
      payload: { role_id: narrowRoleId },
    });
    expect(replace.statusCode).toBe(403);
    expect(replace.json()).toMatchObject({ error: 'target_outranks_actor' });

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${pid(SECOND_OWNER_STEAM)}/role`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(403);
    expect(remove.json()).toMatchObject({ error: 'target_outranks_actor' });
    expect(await roleOf(SECOND_OWNER_STEAM)).toBe(ownerRoleId);
  });

  it('still lets a non-Owner assign and remove a role within their own grants', async () => {
    const cookie = await loginAs(ASSIGNER_STEAM);
    const assign = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/players/${pid(TARGET_STEAM)}/role`,
      headers: { cookie },
      payload: { role_id: narrowRoleId },
    });
    expect(assign.statusCode).toBe(200);
    expect(await roleOf(TARGET_STEAM)).toBe(narrowRoleId);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${pid(TARGET_STEAM)}/role`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(200);
    expect(await roleOf(TARGET_STEAM)).toBeNull();
  });

  it('still lets an Owner remove another Owner', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${pid(SECOND_OWNER_STEAM)}/role`,
      headers: { cookie: await loginAs(OWNER_STEAM) },
    });
    expect(res.statusCode).toBe(200);
    expect(await roleOf(SECOND_OWNER_STEAM)).toBeNull();
  });
});

describeIfDb('/api/v1/roles/:id/members* — role hierarchy (#233)', () => {
  it('refuses adding yourself or another player to a wider role', async () => {
    const cookie = await loginAs(ASSIGNER_STEAM);
    const self = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${wideRoleId}/members`,
      headers: { cookie },
      payload: { player_id: pid(ASSIGNER_STEAM) },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ error: 'cannot_change_own_role' });

    const other = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${wideRoleId}/members`,
      headers: { cookie },
      payload: { player_id: pid(TARGET_STEAM) },
    });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: 'role_exceeds_actor_permissions' });

    const imported = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${wideRoleId}/members/import`,
      headers: { cookie },
      payload: { csv: String(TARGET_STEAM) },
    });
    expect(imported.statusCode).toBe(403);
    expect(await roleOf(TARGET_STEAM)).toBeNull();
  });

  it('refuses a non-Owner removing or moving Owners', async () => {
    const cookie = await loginAs(ASSIGNER_STEAM);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${ownerRoleId}/members/${pid(SECOND_OWNER_STEAM)}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(403);

    const bulk = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${ownerRoleId}/members/bulk-delete`,
      headers: { cookie },
      payload: { player_ids: [pid(SECOND_OWNER_STEAM)] },
    });
    expect(bulk.statusCode).toBe(403);

    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${ownerRoleId}/members/move`,
      headers: { cookie },
      payload: { player_ids: [pid(SECOND_OWNER_STEAM)], target_role_id: narrowRoleId },
    });
    expect(moved.statusCode).toBe(403);
    expect(await roleOf(SECOND_OWNER_STEAM)).toBe(ownerRoleId);
  });

  it('still lets a non-Owner add another player to a role within their grants', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles/${narrowRoleId}/members`,
      headers: { cookie: await loginAs(ASSIGNER_STEAM) },
      payload: { player_id: pid(TARGET_STEAM) },
    });
    expect(res.statusCode).toBe(201);
    expect(await roleOf(TARGET_STEAM)).toBe(narrowRoleId);
  });
});

describeIfDb('POST/PUT/DELETE /api/v1/roles — role hierarchy (#267)', () => {
  it('refuses an editor widening the role they hold', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${editorRoleId}`,
      headers: { cookie: await loginAs(EDITOR_STEAM) },
      payload: { can_assign_roles: true, can_view_ips: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'cannot_edit_own_role' });
    const [row] = await h.db.select().from(roles).where(eq(roles.id, editorRoleId));
    expect(row?.canAssignRoles).toBe(false);
    expect(row?.canViewIps).toBe(false);
  });

  it('refuses an editor granting another role a flag or squad permission they lack', async () => {
    const cookie = await loginAs(EDITOR_STEAM);
    const flag = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${narrowRoleId}`,
      headers: { cookie },
      payload: { can_view_ips: true },
    });
    expect(flag.statusCode).toBe(403);
    expect(flag.json()).toMatchObject({
      error: 'role_exceeds_actor_permissions',
      missing: expect.arrayContaining(['can_view_ips']),
    });

    const squad = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${narrowRoleId}`,
      headers: { cookie },
      payload: { squad_permissions: ['ban'] },
    });
    expect(squad.statusCode).toBe(403);
    expect(squad.json()).toMatchObject({ missing: expect.arrayContaining(['squad:ban']) });

    const [row] = await h.db.select().from(roles).where(eq(roles.id, narrowRoleId));
    expect(row?.canViewIps).toBe(false);
  });

  it('refuses an editor creating a role wider than their own', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: await loginAs(EDITOR_STEAM) },
      payload: {
        name: 'HierarchyEscalation',
        color: 'emerald',
        panel_access: true,
        can_assign_roles: true,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'role_exceeds_actor_permissions' });
  });

  it('refuses an editor editing or deleting a role above them', async () => {
    const cookie = await loginAs(EDITOR_STEAM);
    const edit = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${wideRoleId}`,
      headers: { cookie },
      payload: { can_view_ips: false },
    });
    expect(edit.statusCode).toBe(403);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${wideRoleId}`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(403);
    const [row] = await h.db.select().from(roles).where(eq(roles.id, wideRoleId));
    expect(row?.canViewIps).toBe(true);
  });

  it('still lets an editor edit another role within their grants', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${narrowRoleId}`,
      headers: { cookie: await loginAs(EDITOR_STEAM) },
      payload: { description: 'edited within grants' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still lets an Owner grant any flag', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${editorRoleId}`,
      headers: { cookie: await loginAs(OWNER_STEAM) },
      payload: { can_view_ips: true },
    });
    expect(res.statusCode).toBe(200);
  });
});
