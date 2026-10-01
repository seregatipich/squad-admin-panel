import {
  adminsCfgSyncOutbox,
  clanMembers,
  clans,
  players,
  roleSquadPermissions,
  roles,
  servers,
} from '@squad/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(895001);
const MANAGER_STEAM = testSteamId(895002);
const NOBODY_STEAM = testSteamId(895003);

let h: IntegrationHarness;
let managerCookie: string;
let nobodyCookie: string;
let serverId: string;
let reserveRoleId: string;
/** A `panel_access` role without `can_manage_clans`, held by clan deputies acting through the panel. */
let panelMemberRoleId: string;

let playerSeq = 895100;
let clanSeq = 0;

function jsonHeaders(cookie: string) {
  return { cookie, 'content-type': 'application/json' };
}

interface SeededPlayer {
  id: string;
  steamId64: bigint;
}

async function seedPlayer(name: string): Promise<SeededPlayer> {
  playerSeq += 1;
  const steamId64 = testSteamId(playerSeq);
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return { id: row.id, steamId64 };
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  canManageClans: boolean;
  panelAccess: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canManageClans: opts.canManageClans,
  });
  const stub = `PrioTest${String(opts.steamId64).slice(-4)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player for ${opts.roleName}`);
  return row.id;
}

async function makeCookieFor(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'clan-priority-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface SeededClan {
  clanId: string;
  leaderId: string;
  memberId: string;
  memberSteamId64: bigint;
}

async function seedClan(
  opts: {
    maxPrioritySlots?: number;
    priorityExpiresAt?: Date | null;
    leaderHasPriority?: boolean;
  } = {},
): Promise<SeededClan> {
  clanSeq += 1;
  const clanId = uuidv7();
  await h.db.insert(clans).values({
    id: clanId,
    name: `Приоритет-клан-${clanSeq}`,
    tags: [],
    maxPrioritySlots: opts.maxPrioritySlots ?? 5,
    priorityExpiresAt: opts.priorityExpiresAt ?? null,
  });
  const leader = await seedPlayer(`ЛидерПриоритета${clanSeq}`);
  const member = await seedPlayer(`ЧленПриоритета${clanSeq}`);
  await h.db.insert(clanMembers).values([
    {
      clanId,
      playerId: leader.id,
      memberRole: 'leader',
      hasPriority: opts.leaderHasPriority ?? false,
    },
    { clanId, playerId: member.id, memberRole: 'member', hasPriority: false },
  ]);
  return { clanId, leaderId: leader.id, memberId: member.id, memberSteamId64: member.steamId64 };
}

async function drainSyncStream(): Promise<void> {
  await h.db.delete(adminsCfgSyncOutbox).where(eq(adminsCfgSyncOutbox.serverId, serverId));
  await h.redis.del(`events:admins-cfg-sync:${serverId}`);
}

async function latestSyncReason(): Promise<string | null> {
  const [row] = await h.db
    .select({ payload: adminsCfgSyncOutbox.payload })
    .from(adminsCfgSyncOutbox)
    .where(eq(adminsCfgSyncOutbox.serverId, serverId))
    .orderBy(desc(adminsCfgSyncOutbox.createdAt))
    .limit(1);
  return (row?.payload as { reason?: string } | undefined)?.reason ?? null;
}

async function syncTaskCount(): Promise<number> {
  return (
    await h.db
      .select({ id: adminsCfgSyncOutbox.id })
      .from(adminsCfgSyncOutbox)
      .where(eq(adminsCfgSyncOutbox.serverId, serverId))
  ).length;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'PriorityOwner' },
    bridge: makeFakeBridge(),
  });
  await loginAsOwner(h);

  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Приоритет-сервер',
    slug: `priority-server-${serverId}`,
  });

  const managerId = await seedRoleWithPlayer({
    roleName: 'PriorityManager',
    steamId64: MANAGER_STEAM,
    canManageClans: true,
    panelAccess: true,
  });
  const nobodyId = await seedRoleWithPlayer({
    roleName: 'PriorityNobodyRole',
    steamId64: NOBODY_STEAM,
    canManageClans: false,
    panelAccess: true,
  });
  managerCookie = await makeCookieFor(managerId);
  nobodyCookie = await makeCookieFor(nobodyId);

  panelMemberRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: panelMemberRoleId,
    name: 'PriorityPanelMemberRole',
    color: '#557799',
    panelAccess: true,
  });

  reserveRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: reserveRoleId,
    name: 'PriorityReserveRole',
    color: '#557799',
    panelAccess: false,
  });
  await h.db
    .insert(roleSquadPermissions)
    .values({ roleId: reserveRoleId, squadPermissionKey: 'reserve' });
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('PUT /api/v1/clans/:id/members/:playerId/priority', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-member without can_manage_clans with 403', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(403);
  });

  // Audit #125 — like adding and removing members, a deputy may act on
  // rank-and-file members only: not on the leader, another deputy or itself.
  it('lets a deputy toggle only rank-and-file members', async () => {
    const clan = await seedClan({ leaderHasPriority: true });
    const deputy = await seedPlayer('ЗаместительПриоритета');
    const otherDeputy = await seedPlayer('ВторойЗаместитель');
    await h.db
      .update(players)
      .set({ roleId: panelMemberRoleId })
      .where(eq(players.steamId64, deputy.steamId64));
    await h.db.insert(clanMembers).values([
      { clanId: clan.clanId, playerId: deputy.id, memberRole: 'deputy', hasPriority: false },
      { clanId: clan.clanId, playerId: otherDeputy.id, memberRole: 'deputy', hasPriority: false },
    ]);
    const deputyCookie = await makeCookieFor(deputy.id);
    const toggle = (playerId: string, enabled: boolean) =>
      h.app.inject({
        method: 'PUT',
        url: `/api/v1/clans/${clan.clanId}/members/${playerId}/priority`,
        headers: jsonHeaders(deputyCookie),
        payload: JSON.stringify({ enabled }),
      });

    await drainSyncStream();
    for (const [playerId, enabled] of [
      [clan.leaderId, false],
      [otherDeputy.id, true],
      [deputy.id, true],
    ] as const) {
      const res = await toggle(playerId, enabled);
      expect(res.statusCode, res.body).toBe(403);
    }
    const rows = await h.db
      .select({ playerId: clanMembers.playerId, hasPriority: clanMembers.hasPriority })
      .from(clanMembers)
      .where(eq(clanMembers.clanId, clan.clanId));
    const priority = new Map(rows.map((row) => [row.playerId, row.hasPriority]));
    expect(priority.get(clan.leaderId)).toBe(true);
    expect(priority.get(otherDeputy.id)).toBe(false);
    expect(priority.get(deputy.id)).toBe(false);
    expect(await syncTaskCount()).toBe(0);

    const allowed = await toggle(clan.memberId, true);
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('enables priority, writes an audit row, and publishes an admins-cfg sync event', async () => {
    const clan = await seedClan();
    await drainSyncStream();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      has_priority: boolean;
      priority_count: number;
      max_priority_slots: number;
    };
    expect(body.has_priority).toBe(true);
    expect(body.priority_count).toBe(1);
    expect(body.max_priority_slots).toBe(5);

    const [row] = await h.db
      .select({ hasPriority: clanMembers.hasPriority })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, clan.memberId)));
    expect(row?.hasPriority).toBe(true);

    await assertAuditRow(h, {
      action: 'clan.member.priority',
      resource: 'clan',
      targetId: clan.clanId,
    });

    const len = await syncTaskCount();
    expect(len).toBeGreaterThanOrEqual(1);
    expect(await latestSyncReason()).toBe('clan.priority.toggle');
  });

  it('rejects enabling beyond the pool limit with 409 and leaves the DB unchanged', async () => {
    const clan = await seedClan({ maxPrioritySlots: 1, leaderHasPriority: true });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'priority_pool_limit', limit: 1, used: 1 });
    const [row] = await h.db
      .select({ hasPriority: clanMembers.hasPriority })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, clan.memberId)));
    expect(row?.hasPriority).toBe(false);
  });

  it('checks the pool against a limit lowered while the toggle waited (#130)', async () => {
    const clan = await seedClan({ maxPrioritySlots: 2, leaderHasPriority: true });
    // Lower the limit while holding the clan row lock, so the toggle has
    // already loaded the old limit when it queues on that lock.
    let pending: Promise<{ statusCode: number; json: () => unknown }> | undefined;
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM clans WHERE id = ${clan.clanId} FOR UPDATE`);
      pending = h.app.inject({
        method: 'PUT',
        url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
        headers: jsonHeaders(managerCookie),
        payload: JSON.stringify({ enabled: true }),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.update(clans).set({ maxPrioritySlots: 1 }).where(eq(clans.id, clan.clanId));
    });
    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(res?.json()).toMatchObject({ error: 'priority_pool_limit', limit: 1, used: 1 });
  });

  it('rejects enabling when the clan priority window has expired with 409', async () => {
    const clan = await seedClan({ priorityExpiresAt: new Date(Date.now() - 60_000) });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'priority_expired' });
  });

  it('rejects enabling for a player whose role already grants the reserve squad permission', async () => {
    const clan = await seedClan();
    await h.db
      .update(players)
      .set({ roleId: reserveRoleId })
      .where(eq(players.steamId64, clan.memberSteamId64));
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}/priority`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ enabled: true }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'priority_source_conflict' });
  });

  it('disables priority and publishes a sync event', async () => {
    const clan = await seedClan({ leaderHasPriority: true });
    await drainSyncStream();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.leaderId}/priority`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ enabled: false }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { has_priority: boolean }).has_priority).toBe(false);
    const priorityRows = await h.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(and(eq(clanMembers.playerId, clan.leaderId), eq(clanMembers.hasPriority, true)));
    expect(priorityRows).toEqual([]);
    const len = await syncTaskCount();
    expect(len).toBeGreaterThanOrEqual(1);
  });
});

describeIfDb('member/clan removal publishes admins-cfg sync', () => {
  it('DELETE .../members/:playerId publishes a sync event when the removed member had priority', async () => {
    const clan = await seedClan({ leaderHasPriority: false });
    await h.db
      .update(clanMembers)
      .set({ hasPriority: true })
      .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, clan.memberId)));
    await drainSyncStream();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const len = await syncTaskCount();
    expect(len).toBeGreaterThanOrEqual(1);
    expect(await latestSyncReason()).toBe('clan.member.remove');
  });

  it('publishes a sync event when priority was enabled while the removal waited (#129)', async () => {
    const clan = await seedClan({ leaderHasPriority: false });
    await drainSyncStream();
    // Hold the member row lock so the removal has already passed its
    // pre-checks (priority still off) when it queues on the DELETE, then
    // enable priority and commit: the removal must still see the released slot.
    let pending: Promise<{ statusCode: number }> | undefined;
    await h.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM clan_members WHERE clan_id = ${clan.clanId} AND player_id = ${clan.memberId} FOR UPDATE`,
      );
      pending = h.app.inject({
        method: 'DELETE',
        url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
        headers: { cookie: managerCookie },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx
        .update(clanMembers)
        .set({ hasPriority: true })
        .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, clan.memberId)));
    });
    expect((await pending)?.statusCode).toBe(200);
    expect(await syncTaskCount()).toBeGreaterThanOrEqual(1);
    expect(await latestSyncReason()).toBe('clan.member.remove');
  });

  it('DELETE /api/v1/clans/:id (disband) releases priority members and publishes a sync event', async () => {
    const clan = await seedClan({ leaderHasPriority: true });
    await drainSyncStream();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const priorityRows = await h.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(and(eq(clanMembers.playerId, clan.leaderId), eq(clanMembers.hasPriority, true)));
    expect(priorityRows).toEqual([]);
    const len = await syncTaskCount();
    expect(len).toBeGreaterThanOrEqual(1);
    expect(await latestSyncReason()).toBe('clan.disband');
  });
});

describeIfDb('PATCH /api/v1/clans/:id/expire', () => {
  it('extending the deadline into the future resets priority_expiry_processed and publishes a sync', async () => {
    const clan = await seedClan();
    await h.db
      .update(clans)
      .set({ priorityExpiryProcessed: true })
      .where(eq(clans.id, clan.clanId));
    await drainSyncStream();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${clan.clanId}/expire`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ priority_expires_at: future }),
    });
    expect(res.statusCode).toBe(200);
    const [row] = await h.db
      .select({ processed: clans.priorityExpiryProcessed })
      .from(clans)
      .where(eq(clans.id, clan.clanId));
    expect(row?.processed).toBe(false);
    const len = await syncTaskCount();
    expect(len).toBeGreaterThanOrEqual(1);
    expect(await latestSyncReason()).toBe('clan.expire.update');
  });
});

describeIfDb('GET /api/v1/clans/:id/members — reserve_from_role + pool counters', () => {
  it('flags only the reserve-role member and reports priority_count/max_priority_slots', async () => {
    const clan = await seedClan({ maxPrioritySlots: 7, leaderHasPriority: true });
    await h.db
      .update(players)
      .set({ roleId: reserveRoleId })
      .where(eq(players.steamId64, clan.memberSteamId64));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      priority_count: number;
      max_priority_slots: number;
      items: Array<{ player_id: string; reserve_from_role: boolean }>;
    };
    expect(body.max_priority_slots).toBe(7);
    expect(body.priority_count).toBe(1);
    const leaderRow = body.items.find((m) => m.player_id === clan.leaderId);
    const memberRow = body.items.find((m) => m.player_id === clan.memberId);
    expect(leaderRow?.reserve_from_role).toBe(false);
    expect(memberRow?.reserve_from_role).toBe(true);
  });
});
