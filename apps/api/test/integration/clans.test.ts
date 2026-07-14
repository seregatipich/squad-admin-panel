import { clanMembers, clans, players, roles } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(870001);
const NOBODY_STEAM = testSteamId(870003);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let clanId: string;
let memberPlayerId: string;
let nobodyCookie: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(870002),
      canonicalName: 'Рядовой',
      canonicalNameNormalized: 'рядовой',
    })
    .returning({ id: players.id });
  memberPlayerId = member.id;

  clanId = uuidv7();
  await h.db.insert(clans).values({
    id: clanId,
    name: 'Тестовый клан',
    tags: ['TST'],
    description: 'Проверочный клан',
    maxPrioritySlots: 5,
    isPublic: true,
  });
  await h.db.insert(clanMembers).values([
    {
      clanId,
      playerId: h.seed.ownerPlayerId as string,
      memberRole: 'leader',
      hasPriority: true,
    },
    { clanId, playerId: memberPlayerId, memberRole: 'member', hasPriority: false },
  ]);

  const nobodyRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: nobodyRoleId,
    name: 'ClanViewNobodyRole',
    color: '#3366AA',
    panelAccess: false,
    canManageClans: false,
  });
  const [nobody] = await h.db
    .insert(players)
    .values({
      steamId64: NOBODY_STEAM,
      canonicalName: 'НиктоБезДоступа',
      canonicalNameNormalized: 'никтобездоступа',
      roleId: nobodyRoleId,
    })
    .returning({ id: players.id });
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: nobody.id,
    ip: null,
    userAgent: 'clan9-test',
    ttlMs: 21_600_000,
  });
  nobodyCookie = `__Host-sid=${token}`;
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/clans', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/clans' });
    expect(res.statusCode).toBe(401);
  });

  it('lists active clans with member and priority counts', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/clans',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        name: string;
        tags: string[];
        is_public: boolean;
        member_count: number;
        priority_count: number;
      }>;
      total: number;
    };
    const clan = body.items.find((c) => c.id === clanId);
    expect(clan).toBeDefined();
    expect(clan?.name).toBe('Тестовый клан');
    expect(clan?.tags).toEqual(['TST']);
    expect(clan?.is_public).toBe(true);
    expect(clan?.member_count).toBe(2);
    expect(clan?.priority_count).toBe(1);
  });

  it('excludes soft-deleted clans', async () => {
    const deletedId = uuidv7();
    await h.db.insert(clans).values({ id: deletedId, name: 'Удалённый', deletedAt: new Date() });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/clans',
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === deletedId)).toBe(false);
  });

  it('rejects an authenticated user without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/clans',
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('forbidden');
  });
});

describeIfDb('GET /api/v1/clans/:id', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/clans/${clanId}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns clan detail with its roster', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      name: string;
      max_priority_slots: number;
      members: Array<{
        player_id: string;
        canonical_name: string;
        member_role: string;
        has_priority: boolean;
      }>;
    };
    expect(body.id).toBe(clanId);
    expect(body.max_priority_slots).toBe(5);
    expect(body.members).toHaveLength(2);
    const leader = body.members.find((m) => m.member_role === 'leader');
    expect(leader?.player_id).toBe(h.seed.ownerPlayerId);
    expect(leader?.has_priority).toBe(true);
    expect(leader?.canonical_name).toBe('Owner');
    const member = body.members.find((m) => m.member_role === 'member');
    expect(member?.player_id).toBe(memberPlayerId);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an authenticated user without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('forbidden');
  });
});
