import { clanMembers, clans, players, roles } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(895001);
const NOBODY_STEAM = testSteamId(895002);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let nobodyCookie: string;
let clanId: string;
let leaderPlayerId: string;
let memberPlayerId: string;

async function makeCookieFor(playerId: string): Promise<string> {
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'clan9-roster-export-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
  ownerCookie = await loginAsOwner(h);
  leaderPlayerId = h.seed.ownerPlayerId as string;

  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(895003),
      canonicalName: 'Экспорт, "Тест"',
      canonicalNameNormalized: 'экспорт тест',
    })
    .returning({ id: players.id });
  memberPlayerId = member.id;

  clanId = uuidv7();
  await h.db.insert(clans).values({
    id: clanId,
    name: 'Клан-экспорта',
    tags: ['EXP'],
    maxPrioritySlots: 5,
  });
  await h.db.insert(clanMembers).values([
    { clanId, playerId: leaderPlayerId, memberRole: 'leader', hasPriority: true },
    { clanId, playerId: memberPlayerId, memberRole: 'member', hasPriority: false },
  ]);

  const nobodyRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: nobodyRoleId,
    name: 'ClanExportNobodyRole',
    color: '#3366AA',
    panelAccess: false,
    canManageClans: false,
  });
  const [nobody] = await h.db
    .insert(players)
    .values({
      steamId64: NOBODY_STEAM,
      canonicalName: 'НиктоЭкспорта',
      canonicalNameNormalized: 'никтоэкспорта',
      roleId: nobodyRoleId,
    })
    .returning({ id: players.id });
  nobodyCookie = await makeCookieFor(nobody.id);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/clans/:id/roster/export', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/roster/export`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/roster/export`,
      headers: { cookie: nobodyCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}/roster/export`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a CSV attachment with a header row and one row per member', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/roster/export?format=csv`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`clan-${clanId}-roster-`);

    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'canonical_name,steam_id64,member_role,has_priority,joined_at,last_seen_at',
    );
    // header + 2 members
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('leader'))).toBe(true);
    expect(lines.some((line) => line.includes('member'))).toBe(true);
    // the member's canonical name contains a comma and a quote — must be
    // RFC 4180 escaped as a single quoted field.
    expect(lines.some((line) => line.startsWith('"Экспорт, ""Тест"""'))).toBe(true);
  });
});
