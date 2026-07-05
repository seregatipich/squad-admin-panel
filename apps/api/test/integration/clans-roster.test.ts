import { clanMembers, clans, playerDailyPresence, players, roles, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const OWNER_STEAM = testSteamId(892001);
const MANAGER_STEAM = testSteamId(892002);
const NOBODY_STEAM = testSteamId(892005);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let managerCookie: string;
let nobodyCookie: string;

let serverId: string;
let unaffiliatedId: string;
let unaffiliatedName: string;

let playerSeq = 893000;
let clanSeq = 0;

function jsonHeaders(cookie: string) {
  return { cookie, 'content-type': 'application/json' };
}

async function seedPlayer(name: string): Promise<string> {
  playerSeq += 1;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(playerSeq),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function makeCookieFor(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'clan3-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  canManageClans: boolean;
  panelAccess: boolean;
  canonicalName: string;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canManageClans: opts.canManageClans,
  });
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: opts.canonicalName,
      canonicalNameNormalized: opts.canonicalName.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player for ${opts.roleName}`);
  return row.id;
}

interface SeededClan {
  clanId: string;
  leaderId: string;
  leaderName: string;
  leaderCookie: string;
  deputyId: string;
  deputyCookie: string;
  memberId: string;
  memberName: string;
}

async function seedClan(): Promise<SeededClan> {
  clanSeq += 1;
  const clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: `Ростер-клан-${clanSeq}`, tags: [] });
  const leaderName = `ЛидерРостера${clanSeq}`;
  const memberName = `РядовойРостера${clanSeq}`;
  const leaderId = await seedPlayer(leaderName);
  const deputyId = await seedPlayer(`ЗамРостера${clanSeq}`);
  const memberId = await seedPlayer(memberName);
  await h.db.insert(clanMembers).values([
    { clanId, playerId: leaderId, memberRole: 'leader', hasPriority: true },
    { clanId, playerId: deputyId, memberRole: 'deputy', hasPriority: false },
    { clanId, playerId: memberId, memberRole: 'member', hasPriority: false },
  ]);
  return {
    clanId,
    leaderId,
    leaderName,
    leaderCookie: await makeCookieFor(leaderId),
    deputyId,
    deputyCookie: await makeCookieFor(deputyId),
    memberId,
    memberName,
  };
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'RosterOwner' },
    bridge: makeFakeBridge(),
  });
  await loginAsOwner(h);

  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Ростер-сервер',
    slug: `roster-server-${serverId}`,
  });

  const managerId = await seedRoleWithPlayer({
    roleName: 'RosterManager',
    steamId64: MANAGER_STEAM,
    canManageClans: true,
    panelAccess: true,
    canonicalName: 'RosterManager',
  });
  const nobodyId = await seedRoleWithPlayer({
    roleName: 'RosterNobodyRole',
    steamId64: NOBODY_STEAM,
    canManageClans: false,
    panelAccess: false,
    canonicalName: 'НиктоРостера',
  });

  unaffiliatedName = 'ЗапаснойИгрок';
  unaffiliatedId = await seedPlayer(unaffiliatedName);

  managerCookie = await makeCookieFor(managerId);
  nobodyCookie = await makeCookieFor(nobodyId);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/clans/:id/members', () => {
  it('returns the roster with presence + last seen for a manager', async () => {
    const clan = await seedClan();
    const today = new Date().toISOString().slice(0, 10);
    await h.db.insert(playerDailyPresence).values({
      playerId: clan.leaderId,
      day: today,
      serverId,
      onlineSeconds: 7200,
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clan.clanId}/members?sort=online&order=desc`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      items: Array<{
        player_id: string;
        member_role: string;
        has_priority: boolean;
        online_60d_seconds: number;
        last_seen_at: string | null;
      }>;
    };
    expect(body.total).toBe(3);
    const leaderRow = body.items.find((m) => m.player_id === clan.leaderId);
    expect(leaderRow?.member_role).toBe('leader');
    expect(leaderRow?.online_60d_seconds).toBe(7200);
    expect(body.items[0]?.player_id).toBe(clan.leaderId);
  });

  it('filters the roster by nickname', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clan.clanId}/members?q=${encodeURIComponent(clan.memberName)}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; items: Array<{ player_id: string }> };
    expect(body.total).toBe(1);
    expect(body.items[0]?.player_id).toBe(clan.memberId);
  });

  it('rejects a user without panel access with 403', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('POST /api/v1/clans/:id/members', () => {
  it('lets a manager add a member and writes an audit row', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('НовыйУчастник');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: target, member_role: 'member' }),
    });
    expect(res.statusCode).toBe(201);
    await assertAuditRow(h, { action: 'clan.member.add', resource: 'clan', targetId: clan.clanId });
    const rows = await h.db
      .select({ role: clanMembers.memberRole })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, target)));
    expect(rows[0]?.role).toBe('member');
  });

  it('rejects adding a player already in a clan with 409', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: clan.leaderId }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('player_already_in_clan');
  });

  it('rejects member_role=leader on add via schema (400)', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('ПопыткаЛидер');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: target, member_role: 'leader' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when adding an unknown player', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: uuidv7() }),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('player_not_found');
  });

  it('forbids a non-manager, non-member with 403', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('ОтказНикто');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ player_id: target }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a clan leader add a member to their own clan', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('ЛидерДобавил');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(clan.leaderCookie),
      payload: JSON.stringify({ player_id: target }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('forbids a deputy from adding a deputy (privates only)', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('ЗамДобавилЗама');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(clan.deputyCookie),
      payload: JSON.stringify({ player_id: target, member_role: 'deputy' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a deputy add a rank-and-file member', async () => {
    const clan = await seedClan();
    const target = await seedPlayer('ЗамДобавилРядового');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/members`,
      headers: jsonHeaders(clan.deputyCookie),
      payload: JSON.stringify({ player_id: target, member_role: 'member' }),
    });
    expect(res.statusCode).toBe(201);
  });
});

describeIfDb('PATCH /api/v1/clans/:id/members/:playerId', () => {
  it('lets a manager promote a member to deputy with an audit row', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ member_role: 'deputy' }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { member_role: string }).member_role).toBe('deputy');
    await assertAuditRow(h, {
      action: 'clan.member.role',
      resource: 'clan',
      targetId: clan.clanId,
    });
  });

  it('rejects demoting the leader directly with 409', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.leaderId}`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ member_role: 'deputy' }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('cannot_demote_leader');
  });

  it('forbids a deputy from changing roles with 403', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: jsonHeaders(clan.deputyCookie),
      payload: JSON.stringify({ member_role: 'deputy' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('DELETE /api/v1/clans/:id/members/:playerId', () => {
  it('lets a manager remove a member with an audit row', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    await assertAuditRow(h, {
      action: 'clan.member.remove',
      resource: 'clan',
      targetId: clan.clanId,
    });
    const rows = await h.db
      .select({ playerId: clanMembers.playerId })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, clan.clanId), eq(clanMembers.playerId, clan.memberId)));
    expect(rows).toHaveLength(0);
  });

  it('rejects removing the sole leader without transfer with 409', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.leaderId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('sole_leader_removal');
  });

  it('forbids a deputy from removing another deputy', async () => {
    const clan = await seedClan();
    const secondDeputy = await seedPlayer('ВторойЗам');
    await h.db
      .insert(clanMembers)
      .values({ clanId: clan.clanId, playerId: secondDeputy, memberRole: 'deputy' });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${secondDeputy}`,
      headers: { cookie: clan.deputyCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a deputy remove a rank-and-file member', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: { cookie: clan.deputyCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('forbids a non-manager, non-member with 403', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clan.clanId}/members/${clan.memberId}`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('POST /api/v1/clans/:id/transfer-leadership', () => {
  it('demotes the old leader and promotes the new one atomically', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/transfer-leadership`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: clan.deputyId }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { leader_id: string; previous_leader_id: string };
    expect(body.leader_id).toBe(clan.deputyId);
    expect(body.previous_leader_id).toBe(clan.leaderId);

    const rows = await h.db
      .select({ playerId: clanMembers.playerId, role: clanMembers.memberRole })
      .from(clanMembers)
      .where(eq(clanMembers.clanId, clan.clanId));
    const leaders = rows.filter((r) => r.role === 'leader');
    expect(leaders).toHaveLength(1);
    expect(leaders[0]?.playerId).toBe(clan.deputyId);
    expect(rows.find((r) => r.playerId === clan.leaderId)?.role).toBe('deputy');
    await assertAuditRow(h, {
      action: 'clan.leadership.transfer',
      resource: 'clan',
      targetId: clan.clanId,
    });
  });

  it('rejects transferring to a non-member with 404', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/transfer-leadership`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ player_id: unaffiliatedId }),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('member_not_found');
  });

  it('forbids a deputy from transferring leadership with 403', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/transfer-leadership`,
      headers: jsonHeaders(clan.deputyCookie),
      payload: JSON.stringify({ player_id: clan.memberId }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a clan leader transfer leadership within their clan', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/clans/${clan.clanId}/transfer-leadership`,
      headers: jsonHeaders(clan.leaderCookie),
      payload: JSON.stringify({ player_id: clan.memberId }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { leader_id: string }).leader_id).toBe(clan.memberId);
  });
});

describeIfDb('GET /api/v1/players/search', () => {
  it('returns the clan_id of a candidate already in a clan', async () => {
    const clan = await seedClan();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/search?q=${encodeURIComponent(clan.leaderName)}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; clan_id: string | null }> };
    const hit = body.items.find((p) => p.id === clan.leaderId);
    expect(hit?.clan_id).toBe(clan.clanId);
  });

  it('returns a null clan_id for an unaffiliated player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/search?q=${encodeURIComponent(unaffiliatedName)}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; clan_id: string | null }> };
    expect(body.items.find((p) => p.id === unaffiliatedId)?.clan_id).toBeNull();
  });

  it('rejects a user without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/search?q=Ростер',
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
