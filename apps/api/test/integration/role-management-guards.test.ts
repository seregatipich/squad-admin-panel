import { players, roleSquadPermissions, roles } from '@squad/db/schema';
import { DISCORD_ROLE_SYNC_STREAM } from '@squad/shared-types';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// Issue #41 findings #259/#1237 (privilege ceiling), #255 (last-Owner race),
// #256 (Discord role sync) and #272 (role audit snapshots).

const OWNER_STEAM = testSteamId(741000);
const SECOND_OWNER_STEAM = testSteamId(741001);
const ASSIGNER_STEAM = testSteamId(741002);
const EDITOR_STEAM = testSteamId(741003);
const TARGET_STEAM = testSteamId(741004);
const TARGET_B_STEAM = testSteamId(741005);
const SEEDED = [SECOND_OWNER_STEAM, ASSIGNER_STEAM, EDITOR_STEAM, TARGET_STEAM, TARGET_B_STEAM];

describeIfDb('role management guards (#41)', () => {
  let h: IntegrationHarness;
  let ownerRoleId: string;
  let assignerRoleId: string;
  let editorRoleId: string;
  let strongRoleId: string;
  let weakRoleId: string;

  /**
   * Players are seeded once (actors cannot be deleted: audit_log is
   * append-only), so each case sets the roles it needs and afterEach resets
   * them. Every write is scoped by the test-range steamId64.
   */
  async function seedPlayer(steamId: bigint, _name: string, roleId: string | null) {
    await h.db.update(players).set({ roleId }).where(eq(players.steamId64, steamId));
    return playerIdOf(steamId);
  }

  async function playerIdOf(steamId64: bigint): Promise<string> {
    const rows = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    if (!rows[0]) throw new Error(`no player ${steamId64}`);
    return rows[0].id;
  }

  async function login(steamId64: bigint): Promise<string> {
    invalidateAllPermissionCaches();
    const { token } = await createSession(h.db, h.redis, {
      playerId: await playerIdOf(steamId64),
      ip: null,
      userAgent: 'role-guards-test',
      ttlMs: 21_600_000,
    });
    return `__Host-sid=${token}`;
  }

  async function roleOf(steamId64: bigint): Promise<string | null> {
    const rows = await h.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    return rows[0]?.roleId ?? null;
  }

  async function discordSyncPlayerIds(sinceId: string): Promise<Array<string | null>> {
    const entries = await h.redis.xrange(DISCORD_ROLE_SYNC_STREAM, `(${sinceId}`, '+');
    return entries.map(([, fields]) => {
      const payload = fields[fields.indexOf('payload') + 1] ?? '{}';
      return (JSON.parse(payload) as { player_id: string | null }).player_id;
    });
  }

  async function discordStreamTip(): Promise<string> {
    const last = await h.redis.xrevrange(DISCORD_ROLE_SYNC_STREAM, '+', '-', 'COUNT', 1);
    return last[0]?.[0] ?? '0-0';
  }

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'GuardOwner' },
      bridge: makeFakeBridge(),
    });
    const ownerRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    if (!ownerRows[0]) throw new Error('Owner role missing');
    ownerRoleId = ownerRows[0].id;

    assignerRoleId = uuidv7();
    editorRoleId = uuidv7();
    strongRoleId = uuidv7();
    weakRoleId = uuidv7();
    await h.db.insert(roles).values([
      { id: assignerRoleId, name: 'GuardAssigner', panelAccess: true, canAssignRoles: true },
      { id: editorRoleId, name: 'GuardEditor', panelAccess: true, canEditRoles: true },
      {
        id: strongRoleId,
        name: 'GuardStrong',
        panelAccess: true,
        canEditRoles: true,
        canViewIps: true,
        canManageIntegrations: true,
      },
      { id: weakRoleId, name: 'GuardWeak', panelAccess: true },
    ]);
    await h.db
      .insert(roleSquadPermissions)
      .values({ roleId: strongRoleId, squadPermissionKey: 'ban' });
    await h.db.insert(players).values(
      SEEDED.map((steamId64) => {
        const name = `Guard${String(steamId64).slice(-4)}`;
        return { steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() };
      }),
    );
  });

  afterEach(async () => {
    // Restore the seeded Owner first: the last-Owner trigger rejects
    // clearing a second Owner while it is the only one left.
    await h.db
      .update(players)
      .set({ roleId: ownerRoleId })
      .where(eq(players.steamId64, OWNER_STEAM));
    for (const steamId64 of SEEDED) {
      await h.db
        .update(players)
        .set({ roleId: null, roleComment: null, roleExpiresAt: null })
        .where(eq(players.steamId64, steamId64));
    }
    await h.db
      .update(roles)
      .set({ canHandleReports: false, canViewIps: false, canAssignRoles: false })
      .where(inArray(roles.id, [weakRoleId, editorRoleId]));
    await h.db.delete(roleSquadPermissions).where(eq(roleSquadPermissions.roleId, weakRoleId));
    invalidateAllPermissionCaches();
  });

  afterAll(async () => {
    await h.cleanup();
  });

  describe('privilege ceiling on role assignment (#259)', () => {
    it('refuses to add a player to a role carrying flags the actor lacks', async () => {
      await seedPlayer(ASSIGNER_STEAM, 'Assigner', assignerRoleId);
      const targetId = await seedPlayer(TARGET_STEAM, 'Target', null);
      const cookie = await login(ASSIGNER_STEAM);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${strongRoleId}/members`,
        headers: { cookie },
        payload: { player_id: targetId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'role_exceeds_actor_permissions' });
      expect((res.json() as { capabilities: string[] }).capabilities).toEqual(
        expect.arrayContaining(['can_edit_roles', 'can_view_ips', 'squad:ban']),
      );
      expect(await roleOf(TARGET_STEAM)).toBeNull();
    });

    it('still lets the actor assign a role within their own permissions', async () => {
      await seedPlayer(ASSIGNER_STEAM, 'Assigner', assignerRoleId);
      const targetId = await seedPlayer(TARGET_STEAM, 'Target', null);
      const cookie = await login(ASSIGNER_STEAM);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members`,
        headers: { cookie },
        payload: { player_id: targetId },
      });
      expect(res.statusCode).toBe(201);
      expect(await roleOf(TARGET_STEAM)).toBe(weakRoleId);
    });

    it('applies the ceiling to CSV import', async () => {
      await seedPlayer(ASSIGNER_STEAM, 'Assigner', assignerRoleId);
      await seedPlayer(TARGET_STEAM, 'Target', null);
      const cookie = await login(ASSIGNER_STEAM);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${strongRoleId}/members/import`,
        headers: { cookie },
        payload: { csv: `${ASSIGNER_STEAM}\n${TARGET_STEAM}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'role_exceeds_actor_permissions' });
      expect(await roleOf(TARGET_STEAM)).toBeNull();
    });

    it('applies the ceiling to moving members into a stronger role', async () => {
      await seedPlayer(ASSIGNER_STEAM, 'Assigner', assignerRoleId);
      const targetId = await seedPlayer(TARGET_STEAM, 'Target', weakRoleId);
      const cookie = await login(ASSIGNER_STEAM);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members/move`,
        headers: { cookie },
        payload: { player_ids: [targetId], target_role_id: strongRoleId },
      });
      expect(res.statusCode).toBe(403);
      expect(await roleOf(TARGET_STEAM)).toBe(weakRoleId);
    });

    // #233 (role hierarchy) is stricter than the ceiling for self-assignment:
    // a non-Owner may not change their own role at all.
    it('refuses PUT /players/:id/role self-escalation', async () => {
      const assignerId = await seedPlayer(ASSIGNER_STEAM, 'Assigner', assignerRoleId);
      const cookie = await login(ASSIGNER_STEAM);
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/players/${assignerId}/role`,
        headers: { cookie },
        payload: { role_id: strongRoleId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'cannot_change_own_role' });
      expect(await roleOf(ASSIGNER_STEAM)).toBe(assignerRoleId);
    });

    it('the Owner is not limited by the ceiling', async () => {
      const targetId = await seedPlayer(TARGET_STEAM, 'Target', null);
      const cookie = await loginAsOwner(h);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${strongRoleId}/members`,
        headers: { cookie },
        payload: { player_id: targetId },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('privilege ceiling on role editing (#1237)', () => {
    it('refuses to grant a role a flag the editor lacks', async () => {
      await seedPlayer(EDITOR_STEAM, 'Editor', editorRoleId);
      const cookie = await login(EDITOR_STEAM);
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${weakRoleId}`,
        headers: { cookie },
        payload: { can_view_ips: true, can_assign_roles: true },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { capabilities: string[] }).capabilities).toEqual([
        'can_assign_roles',
        'can_view_ips',
      ]);
      const row = await h.db.select().from(roles).where(eq(roles.id, weakRoleId)).limit(1);
      expect(row[0]?.canViewIps).toBe(false);
      expect(row[0]?.canAssignRoles).toBe(false);
    });

    // #233 (role hierarchy) is stricter than the flag ceiling: a non-Owner
    // cannot edit the role they hold at all, so no self-escalation is possible.
    it('refuses a non-Owner editing their own role', async () => {
      await seedPlayer(EDITOR_STEAM, 'Editor', editorRoleId);
      const cookie = await login(EDITOR_STEAM);
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${editorRoleId}`,
        headers: { cookie },
        payload: { can_view_ips: true, can_assign_roles: true },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'cannot_edit_own_role' });
      const row = await h.db.select().from(roles).where(eq(roles.id, editorRoleId)).limit(1);
      expect(row[0]?.canViewIps).toBe(false);
      expect(row[0]?.canAssignRoles).toBe(false);
    });

    it('refuses to grant squad permissions the editor lacks', async () => {
      await seedPlayer(EDITOR_STEAM, 'Editor', editorRoleId);
      const cookie = await login(EDITOR_STEAM);
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${weakRoleId}`,
        headers: { cookie },
        payload: { squad_permissions: ['ban', 'changemap'] },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { capabilities: string[] }).capabilities).toEqual([
        'squad:ban',
        'squad:changemap',
      ]);
    });

    it('refuses to create a role stronger than the editor', async () => {
      await seedPlayer(EDITOR_STEAM, 'Editor', editorRoleId);
      const cookie = await login(EDITOR_STEAM);
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: { cookie },
        payload: { name: 'GuardSneaky', color: 'red', can_manage_integrations: true },
      });
      expect(res.statusCode).toBe(403);
      const rows = await h.db.select().from(roles).where(eq(roles.name, 'GuardSneaky'));
      expect(rows).toHaveLength(0);
    });

    // #233 (role hierarchy) refuses any edit of a role that grants more than
    // the editor holds, stricter than #1237, which would allow an edit that
    // adds nothing.
    it('refuses editing a role stronger than the editor’s even when the edit grants nothing new', async () => {
      await seedPlayer(EDITOR_STEAM, 'Editor', editorRoleId);
      const cookie = await login(EDITOR_STEAM);
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${strongRoleId}`,
        headers: { cookie },
        payload: { color: 'green', can_view_ips: true },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'role_exceeds_actor_permissions' });
    });
  });

  describe('audit snapshots on role changes (#272)', () => {
    it('role.update records before/after of flags and squad permissions', async () => {
      const cookie = await loginAsOwner(h);
      const startedAt = Date.now();
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${weakRoleId}`,
        headers: { cookie },
        payload: { can_handle_reports: true, squad_permissions: ['kick'] },
      });
      expect(res.statusCode).toBe(200);
      // Earlier cases wrote refused role.update rows for this role; only rows
      // from this request count.
      const row = await assertAuditRow(h, {
        action: 'role.update',
        resource: 'role',
        targetId: weakRoleId,
        withinMs: Date.now() - startedAt + 1,
      });
      expect(row.beforeSnapshot).toMatchObject({
        can_handle_reports: false,
        squad_permissions: [],
      });
      expect(row.afterSnapshot).toMatchObject({
        can_handle_reports: true,
        squad_permissions: ['kick'],
      });
    });

    it('role.create records the new role id and its after state', async () => {
      const cookie = await loginAsOwner(h);
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: { cookie },
        payload: { name: 'GuardAudited', color: 'blue', panel_access: true },
      });
      expect(res.statusCode).toBe(201);
      const id = (res.json() as { id: string }).id;
      const row = await assertAuditRow(h, {
        action: 'role.create',
        resource: 'role',
        targetId: id,
      });
      expect(row.beforeSnapshot).toBeNull();
      expect(row.afterSnapshot).toMatchObject({ id, name: 'GuardAudited', panel_access: true });

      const del = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/roles/${id}`,
        headers: { cookie },
      });
      expect(del.statusCode).toBe(200);
      const delRow = await assertAuditRow(h, {
        action: 'role.delete',
        resource: 'role',
        targetId: id,
      });
      expect(delRow.beforeSnapshot).toMatchObject({ id, name: 'GuardAudited' });
      expect(delRow.afterSnapshot).toBeNull();
    });
  });

  describe('Discord role sync on role-member changes (#256)', () => {
    it('publishes a sync for every role-members mutation', async () => {
      const targetId = await seedPlayer(TARGET_STEAM, 'Target', null);
      const targetBId = await seedPlayer(TARGET_B_STEAM, 'TargetB', null);
      const cookie = await loginAsOwner(h);

      let tip = await discordStreamTip();
      const add = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members`,
        headers: { cookie },
        payload: { player_id: targetId },
      });
      expect(add.statusCode).toBe(201);
      expect(await discordSyncPlayerIds(tip)).toContain(targetId);

      tip = await discordStreamTip();
      const imported = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members/import`,
        headers: { cookie },
        payload: { csv: `${TARGET_B_STEAM}` },
      });
      expect(imported.statusCode).toBe(201);
      // Bulk operations request one full reconcile rather than N per-player syncs.
      expect(await discordSyncPlayerIds(tip)).toContain(null);

      tip = await discordStreamTip();
      const moved = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members/move`,
        headers: { cookie },
        payload: { player_ids: [targetId], target_role_id: editorRoleId },
      });
      expect(moved.statusCode).toBe(200);
      expect(await discordSyncPlayerIds(tip)).toContain(null);

      tip = await discordStreamTip();
      const bulk = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${weakRoleId}/members/bulk-delete`,
        headers: { cookie },
        payload: { player_ids: [targetBId] },
      });
      expect(bulk.statusCode).toBe(200);
      expect(await discordSyncPlayerIds(tip)).toContain(null);

      tip = await discordStreamTip();
      const del = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/roles/${editorRoleId}/members/${targetId}`,
        headers: { cookie },
      });
      expect(del.statusCode).toBe(200);
      expect(await discordSyncPlayerIds(tip)).toContain(targetId);
    });
  });

  describe('last-Owner protection under concurrency (#255)', () => {
    // The race is closed by the players_last_owner_guard trigger (migration
    // 0107); these cases pin that the route-level pre-checks cannot bypass it.
    async function ownerCount(): Promise<number> {
      return (await h.db.select().from(players).where(eq(players.roleId, ownerRoleId))).length;
    }

    /**
     * Forces the race deterministically: an outside transaction row-locks both
     * Owners, so every request passes its pre-checks and then queues on the
     * write; the lock is released only once all requests are in flight.
     */
    async function raceWhileOwnersLocked(
      fire: () => Array<Promise<{ statusCode: number }>>,
    ): Promise<number[]> {
      const blocker = postgres(h.url, { max: 1, onnotice: () => undefined });
      try {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let signalLocked: () => void = () => undefined;
        const locked = new Promise<void>((resolve) => {
          signalLocked = resolve;
        });
        const holder = blocker.begin(async (tx) => {
          await tx`SELECT id FROM players
            WHERE steam_id64 IN (${String(OWNER_STEAM)}, ${String(SECOND_OWNER_STEAM)})
            FOR UPDATE`;
          signalLocked();
          await released;
        });
        await locked;
        const requests = Promise.all(fire());
        await new Promise((resolve) => setTimeout(resolve, 400));
        release();
        await holder;
        return (await requests).map((r) => r.statusCode).sort();
      } finally {
        await blocker.end({ timeout: 5 });
      }
    }

    it('two concurrent DELETEs of the last two Owners leave one Owner', async () => {
      const secondOwnerId = await seedPlayer(SECOND_OWNER_STEAM, 'SecondOwner', ownerRoleId);
      const ownerId = h.seed.ownerPlayerId as string;
      expect(await ownerCount()).toBe(2);
      const cookie = await loginAsOwner(h);

      const codes = await raceWhileOwnersLocked(() =>
        [ownerId, secondOwnerId].map((playerId) =>
          h.app.inject({
            method: 'DELETE',
            url: `/api/v1/roles/${ownerRoleId}/members/${playerId}`,
            headers: { cookie },
          }),
        ),
      );
      expect(codes).toEqual([200, 409]);
      expect(await ownerCount()).toBe(1);
    });

    it('concurrent bulk-delete and move cannot empty the Owner role', async () => {
      const secondOwnerId = await seedPlayer(SECOND_OWNER_STEAM, 'SecondOwner', ownerRoleId);
      const ownerId = h.seed.ownerPlayerId as string;
      const cookie = await loginAsOwner(h);

      const codes = await raceWhileOwnersLocked(() => [
        h.app.inject({
          method: 'POST',
          url: `/api/v1/roles/${ownerRoleId}/members/bulk-delete`,
          headers: { cookie },
          payload: { player_ids: [ownerId] },
        }),
        h.app.inject({
          method: 'POST',
          url: `/api/v1/roles/${ownerRoleId}/members/move`,
          headers: { cookie },
          payload: { player_ids: [secondOwnerId], target_role_id: weakRoleId },
        }),
      ]);
      expect(codes).toEqual([200, 409]);
      expect(await ownerCount()).toBe(1);
    });

    it('concurrent DELETE /players/:id/role calls cannot empty the Owner role', async () => {
      const secondOwnerId = await seedPlayer(SECOND_OWNER_STEAM, 'SecondOwner', ownerRoleId);
      const ownerId = h.seed.ownerPlayerId as string;
      const cookie = await loginAsOwner(h);

      const codes = await raceWhileOwnersLocked(() =>
        [ownerId, secondOwnerId].map((playerId) =>
          h.app.inject({
            method: 'DELETE',
            url: `/api/v1/players/${playerId}/role`,
            headers: { cookie },
          }),
        ),
      );
      expect(codes).toEqual([200, 409]);
      expect(await ownerCount()).toBe(1);
    });
  });
});
