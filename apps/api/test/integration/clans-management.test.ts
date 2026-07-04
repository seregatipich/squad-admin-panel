import { createHash } from 'node:crypto';
import { clanMembers, clans, players, roles } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
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

const OWNER_STEAM = testSteamId(880001);
const MANAGER_STEAM = testSteamId(880002);
const LEADER_STEAM = testSteamId(880003);
const NOBODY_STEAM = testSteamId(880004);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let managerCookie: string;
let leaderCookie: string;
let nobodyCookie: string;
let leaderPlayerId: string;

let leaderClanId: string;
let otherClanId: string;
let capClanId: string;

let playerSeq = 890000;

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
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
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

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'clan2-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function createClanWithLeader(opts: {
  name: string;
  tags?: string[];
  leaderId: string;
  leaderHasPriority?: boolean;
  maxPrioritySlots?: number;
  extraMemberId?: string;
}): Promise<string> {
  const clanId = uuidv7();
  await h.db.insert(clans).values({
    id: clanId,
    name: opts.name,
    tags: opts.tags ?? [],
    maxPrioritySlots: opts.maxPrioritySlots ?? 5,
  });
  const memberRows = [
    {
      clanId,
      playerId: opts.leaderId,
      memberRole: 'leader',
      hasPriority: opts.leaderHasPriority ?? false,
    },
  ];
  if (opts.extraMemberId) {
    memberRows.push({
      clanId,
      playerId: opts.extraMemberId,
      memberRole: 'member',
      hasPriority: false,
    });
  }
  await h.db.insert(clanMembers).values(memberRows);
  return clanId;
}

function jsonHeaders(cookie: string) {
  return { cookie, 'content-type': 'application/json' };
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'ClanOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  await seedRoleWithPlayer({
    roleName: 'ClanManager',
    steamId64: MANAGER_STEAM,
    canManageClans: true,
    panelAccess: true,
  });
  leaderPlayerId = await seedRoleWithPlayer({
    roleName: 'ClanLeaderRole',
    steamId64: LEADER_STEAM,
    canManageClans: false,
    panelAccess: false,
  });
  await seedRoleWithPlayer({
    roleName: 'ClanNobodyRole',
    steamId64: NOBODY_STEAM,
    canManageClans: false,
    panelAccess: false,
  });

  managerCookie = await loginAsSteam(MANAGER_STEAM);
  leaderCookie = await loginAsSteam(LEADER_STEAM);
  nobodyCookie = await loginAsSteam(NOBODY_STEAM);

  leaderClanId = await createClanWithLeader({
    name: 'Клан-лидера',
    tags: ['LEAD'],
    leaderId: leaderPlayerId,
    extraMemberId: await seedPlayer('ЧленКлана'),
  });
  otherClanId = await createClanWithLeader({
    name: 'Чужой-клан',
    tags: ['OTHER'],
    leaderId: await seedPlayer('ЧужойЛидер'),
  });
  capClanId = await createClanWithLeader({
    name: 'Кап-клан',
    leaderId: await seedPlayer('КапЛидер'),
    leaderHasPriority: true,
    maxPrioritySlots: 3,
  });
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('roles route surfaces can_manage_clans', () => {
  it('creates and lists a role carrying can_manage_clans', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: jsonHeaders(ownerCookie),
      payload: JSON.stringify({
        name: 'ClanRoleFlagCheck',
        color: '#557799',
        panel_access: true,
        can_manage_clans: true,
      }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; can_manage_clans: boolean };
    expect(body.can_manage_clans).toBe(true);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
    });
    const roleRows = list.json() as Array<{ id: string; can_manage_clans: boolean }>;
    expect(roleRows.find((r) => r.id === body.id)?.can_manage_clans).toBe(true);
  });

  it('reports can_manage_clans on /api/v1/me for a manager', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: managerCookie },
    });
    const me = res.json() as { can_manage_clans: boolean };
    expect(me.can_manage_clans).toBe(true);
  });
});

describeIfDb('POST /api/v1/clans', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'NoAuthClan' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without can_manage_clans with 403', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ name: 'NobodyClan' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a bare clan leader (no can_manage_clans) from creating with 403', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ name: 'LeaderCreatedClan' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a manager create a clan and writes a clan.create audit row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({
        name: 'Альфа',
        description: 'Первый клан',
        tags: ['ALFA'],
        max_priority_slots: 20,
        is_public: true,
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      name: string;
      tags: string[];
      max_priority_slots: number;
      is_public: boolean;
    };
    expect(body.name).toBe('Альфа');
    expect(body.tags).toEqual(['ALFA']);
    expect(body.max_priority_slots).toBe(20);
    expect(body.is_public).toBe(true);
    const audit = await assertAuditRow(h, {
      action: 'clan.create',
      resource: 'clan',
      targetId: body.id,
    });
    expect(audit.beforeSnapshot).toBeNull();
    expect((audit.afterSnapshot as { name: string }).name).toBe('Альфа');
  });

  it('rejects a name longer than 32 chars with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'x'.repeat(33) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a tag containing a comma with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'CommaTag', tags: ['A,B'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects max_priority_slots above 999 with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'TooManySlots', max_priority_slots: 1000 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate active name with 409', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'ДубльИмя' }),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'ДубльИмя' }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('clan_name_taken');
  });

  it('rejects a tag already owned by another clan with 409', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'TagOwner', tags: ['UNIQ'] }),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/clans',
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'TagThief', tags: ['UNIQ'] }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('clan_tag_taken');
  });
});

describeIfDb('PATCH /api/v1/clans/:id (core fields)', () => {
  it('lets a clan leader edit only the description of their clan', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ description: 'Отредактировано лидером' }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { description: string }).description).toBe('Отредактировано лидером');
    await assertAuditRow(h, { action: 'clan.update', resource: 'clan', targetId: leaderClanId });
  });

  it('forbids a leader from renaming their clan (privileged field) with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ name: 'ЛидерПереименовал' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a leader from changing tags/slots of their clan with 403', async () => {
    const tagsRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ tags: ['NEWTAG'] }),
    });
    expect(tagsRes.statusCode).toBe(403);
    const slotsRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ max_priority_slots: 1 }),
    });
    expect(slotsRes.statusCode).toBe(403);
  });

  it('forbids a leader from editing another clan with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${otherClanId}`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ description: 'Чужое описание' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a user with neither flag nor leadership with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ description: 'Никто' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a manager rename a clan and change privileged fields', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${otherClanId}`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ name: 'Переименован', max_priority_slots: 9 }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; max_priority_slots: number };
    expect(body.name).toBe('Переименован');
    expect(body.max_priority_slots).toBe(9);
  });

  it('rejects lowering max_priority_slots below current priority members with 409', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${capClanId}`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ max_priority_slots: 0 }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('priority_capacity_exceeded');
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${uuidv7()}`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ description: 'x' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('PATCH /api/v1/clans/:id/settings', () => {
  it('lets a clan leader toggle public/tag-protection of their clan', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/settings`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ is_public: true, is_tag_protected: true }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { is_public: boolean; is_tag_protected: boolean };
    expect(body.is_public).toBe(true);
    expect(body.is_tag_protected).toBe(true);
    await assertAuditRow(h, {
      action: 'clan.settings.update',
      resource: 'clan',
      targetId: leaderClanId,
    });
  });

  it('forbids a non-member without the flag with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/settings`,
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ is_public: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a manager toggle settings on any clan', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/settings`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ is_public: false }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { is_public: boolean }).is_public).toBe(false);
  });
});

describeIfDb('PATCH /api/v1/clans/:id/expire', () => {
  it('forbids a clan leader from changing expiry with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/expire`,
      headers: jsonHeaders(leaderCookie),
      payload: JSON.stringify({ priority_expires_at: new Date(Date.now() + 8.64e7).toISOString() }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a manager set and clear the priority expiry', async () => {
    const future = new Date(Date.now() + 30 * 8.64e7).toISOString();
    const setRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/expire`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ priority_expires_at: future }),
    });
    expect(setRes.statusCode).toBe(200);
    expect(
      (setRes.json() as { priority_expires_at: string | null }).priority_expires_at,
    ).not.toBeNull();
    await assertAuditRow(h, {
      action: 'clan.expire.update',
      resource: 'clan',
      targetId: leaderClanId,
    });

    const clearRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/expire`,
      headers: jsonHeaders(managerCookie),
      payload: JSON.stringify({ priority_expires_at: null }),
    });
    expect(clearRes.statusCode).toBe(200);
    expect(
      (clearRes.json() as { priority_expires_at: string | null }).priority_expires_at,
    ).toBeNull();
  });

  it('forbids a non-member without the flag with 403', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/clans/${leaderClanId}/expire`,
      headers: jsonHeaders(nobodyCookie),
      payload: JSON.stringify({ priority_expires_at: null }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('DELETE /api/v1/clans/:id (disband)', () => {
  it('forbids a clan leader from disbanding their own clan with 403', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${leaderClanId}`,
      headers: { cookie: leaderCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a user without the flag with 403', async () => {
    const clanId = await createClanWithLeader({
      name: 'Роспуск-никто',
      leaderId: await seedPlayer('РоспускЛидерA'),
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('soft-deletes a clan: gone from directory, roster retained, priorities cleared', async () => {
    const disbandLeaderId = await seedPlayer('РоспускЛидерB');
    const disbandMemberId = await seedPlayer('РоспускЧлен');
    const clanId = await createClanWithLeader({
      name: 'Роспуск-клан',
      tags: ['DEAD'],
      leaderId: disbandLeaderId,
      leaderHasPriority: true,
      maxPrioritySlots: 5,
      extraMemberId: disbandMemberId,
    });

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/clans',
      headers: { cookie: managerCookie },
    });
    const listBody = list.json() as { items: Array<{ id: string }> };
    expect(listBody.items.some((c) => c.id === clanId)).toBe(false);

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: managerCookie },
    });
    expect(detail.statusCode).toBe(404);

    const retained = await h.db
      .select({ playerId: clanMembers.playerId, hasPriority: clanMembers.hasPriority })
      .from(clanMembers)
      .where(eq(clanMembers.clanId, clanId));
    expect(retained).toHaveLength(2);
    expect(retained.every((m) => m.hasPriority === false)).toBe(true);

    const softDeleted = await h.db
      .select({ deletedAt: clans.deletedAt })
      .from(clans)
      .where(eq(clans.id, clanId))
      .limit(1);
    expect(softDeleted[0]?.deletedAt).not.toBeNull();

    await assertAuditRow(h, { action: 'clan.disband', resource: 'clan', targetId: clanId });
  });
});

describeIfDb('audit_log hash-chain integrity after clan mutations', () => {
  it('links every audit row and verifies each row hash', async () => {
    const rows = (await h.db.execute(sql`
      SELECT
        action_type,
        target_type,
        target_id,
        context::text AS context_text,
        created_at::text AS created_at_text,
        encode(prev_hash, 'hex') AS prev_hash_hex,
        encode(row_hash, 'hex') AS row_hash_hex
      FROM audit_log
      ORDER BY id ASC
    `)) as unknown as Array<{
      action_type: string;
      target_type: string | null;
      target_id: string | null;
      context_text: string;
      created_at_text: string;
      prev_hash_hex: string | null;
      row_hash_hex: string;
    }>;

    expect(rows.length).toBeGreaterThan(0);

    let prevHex: string | null = null;
    for (const row of rows) {
      expect(row.prev_hash_hex).toBe(prevHex);
      const prev = prevHex ? Buffer.from(prevHex, 'hex') : Buffer.alloc(0);
      const canonical = [
        row.action_type,
        row.target_type ?? '',
        row.target_id ?? '',
        row.context_text,
        row.created_at_text,
      ].join('|');
      const expected = createHash('sha256')
        .update(Buffer.concat([prev, Buffer.from(canonical, 'utf-8')]))
        .digest('hex');
      expect(row.row_hash_hex).toBe(expected);
      prevHex = row.row_hash_hex;
    }

    const clanActions = rows.map((r) => r.action_type).filter((a) => a.startsWith('clan.'));
    expect(clanActions).toContain('clan.create');
    expect(clanActions).toContain('clan.update');
    expect(clanActions).toContain('clan.settings.update');
    expect(clanActions).toContain('clan.expire.update');
    expect(clanActions).toContain('clan.disband');
  });
});
