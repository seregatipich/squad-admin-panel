import { clanMembers, clans, players, roles } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(870001);
const NOBODY_STEAM = testSteamId(870003);

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
  if (!member) throw new Error('member: insert returned no row');
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
  if (!nobody) throw new Error('nobody: insert returned no row');
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

  describe('server-side q/sort/order/page/limit', () => {
    const PAGED_PREFIX = 'Пагинация-';
    const pagedIds: string[] = [];

    beforeAll(async () => {
      // Three clans with distinct member counts (0, 1, 2) and one searchable tag.
      for (const [index, suffix] of ['Бета', 'Альфа', 'Гамма'].entries()) {
        const id = uuidv7();
        pagedIds.push(id);
        await h.db.insert(clans).values({
          id,
          name: `${PAGED_PREFIX}${suffix}`,
          tags: index === 2 ? ['ZZQ'] : [],
        });
        if (index > 0) {
          const extra = await h.db
            .insert(players)
            .values(
              Array.from({ length: index }, (_, n) => ({
                steamId64: testSteamId(871000 + index * 10 + n),
                canonicalName: `Пагин-${index}-${n}`,
                canonicalNameNormalized: `пагин-${index}-${n}`,
              })),
            )
            .returning({ id: players.id });
          await h.db.insert(clanMembers).values(
            extra.map((p, n) => ({
              clanId: id,
              playerId: p.id,
              memberRole: n === 0 ? 'leader' : 'member',
            })),
          );
        }
      }
    });

    async function list(query: string) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/clans?${query}`,
        headers: { cookie: await loginAsOwner(h) },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        items: Array<{ name: string; member_count: number }>;
        total: number;
      };
    }

    it('filters by name substring and reports the matching total', async () => {
      const body = await list(`q=${encodeURIComponent('пагинация-а')}`);
      expect(body.items.map((c) => c.name)).toEqual([`${PAGED_PREFIX}Альфа`]);
      expect(body.total).toBe(1);
    });

    it('filters by tag', async () => {
      const body = await list('q=zzq');
      expect(body.items.map((c) => c.name)).toEqual([`${PAGED_PREFIX}Гамма`]);
    });

    it('sorts by member count descending and paginates with the full total', async () => {
      const first = await list(
        `q=${encodeURIComponent(PAGED_PREFIX)}&sort=members&order=desc&page=1&limit=2`,
      );
      expect(first.total).toBe(3);
      expect(first.items.map((c) => c.member_count)).toEqual([2, 1]);
      const second = await list(
        `q=${encodeURIComponent(PAGED_PREFIX)}&sort=members&order=desc&page=2&limit=2`,
      );
      expect(second.total).toBe(3);
      expect(second.items.map((c) => c.member_count)).toEqual([0]);
    });

    it('treats LIKE wildcards in q literally', async () => {
      const body = await list(`q=${encodeURIComponent('%')}`);
      expect(body.items).toEqual([]);
    });

    it('rejects an out-of-range limit with 400', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/clans?limit=100000',
        headers: { cookie: await loginAsOwner(h) },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('rejects an authenticated user without panel access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/clans',
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe('unauthenticated');
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

  it('omits the roster but keeps priority_count for ?include=none', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}?include=none`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; priority_count: number; members?: unknown };
    expect(body.id).toBe(clanId);
    expect(body.priority_count).toBe(1);
    expect(body).not.toHaveProperty('members');
  });

  it('rejects an unknown include value with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}?include=everything`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an authenticated user without panel access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe('unauthenticated');
  });
});
