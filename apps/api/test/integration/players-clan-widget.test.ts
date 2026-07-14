import { clanMembers, clans, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(896001);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let clanId: string;
let leaderPlayerId: string;
let memberPlayerId: string;
let clanlessPlayerId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
  ownerCookie = await loginAsOwner(h);

  const [leader] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(896004),
      canonicalName: 'ЛидерВиджета',
      canonicalNameNormalized: 'лидервиджета',
    })
    .returning({ id: players.id });
  leaderPlayerId = leader.id;

  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(896002),
      canonicalName: 'ЧленКлана',
      canonicalNameNormalized: 'членклана',
    })
    .returning({ id: players.id });
  memberPlayerId = member.id;

  const [clanless] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(896003),
      canonicalName: 'БезКлана',
      canonicalNameNormalized: 'безклана',
    })
    .returning({ id: players.id });
  clanlessPlayerId = clanless.id;

  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Клан-виджета', tags: ['WDG'] });
  await h.db.insert(clanMembers).values([
    { clanId, playerId: leaderPlayerId, memberRole: 'leader', hasPriority: false },
    { clanId, playerId: memberPlayerId, memberRole: 'deputy', hasPriority: false },
  ]);
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/players/:playerId clan widget', () => {
  it('returns the clan block for a clan member', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${memberPlayerId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      clan: { id: string; name: string; tags: string[]; member_role: string } | null;
    };
    expect(body.clan).toEqual({
      id: clanId,
      name: 'Клан-виджета',
      tags: ['WDG'],
      member_role: 'deputy',
    });
  });

  it('returns null for a clanless player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${clanlessPlayerId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { clan: unknown };
    expect(body.clan).toBeNull();
  });

  it('returns null after the clan is soft-deleted', async () => {
    await h.db.update(clans).set({ deletedAt: new Date() }).where(eq(clans.id, clanId));
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${memberPlayerId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { clan: unknown };
    expect(body.clan).toBeNull();
  });
});
