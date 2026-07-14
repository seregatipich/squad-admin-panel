import {
  clanMembers,
  clans,
  matches,
  matchPlayers,
  playerStatPeriods,
  players,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

const OWNER_STEAM_ID = testSteamId(961001);
const MEMBER_STEAM_ID = testSteamId(961002);
const SERVER_ID = '019f9600-0000-7000-8000-000000000001';
const PUBLIC_CLAN_ID = '019f9600-0000-7000-8000-000000000002';
const PRIVATE_CLAN_ID = '019f9600-0000-7000-8000-000000000003';
const MATCH_ID = '019f9600-0000-7000-8000-000000000004';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
  const [member] = await h.db
    .insert(players)
    .values({
      steamId64: MEMBER_STEAM_ID,
      canonicalName: 'Публичный участник',
      canonicalNameNormalized: 'публичный участник',
      eosId: 'eos-private-value',
    })
    .returning({ id: players.id });

  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Private Server Name',
    slug: 'public-clan-test-server',
  });
  await h.db.insert(clans).values([
    {
      id: PUBLIC_CLAN_ID,
      name: 'Открытый клан',
      tags: ['PUB'],
      description: 'Публичное описание',
      isPublic: true,
    },
    { id: PRIVATE_CLAN_ID, name: 'Закрытый клан', isPublic: false },
  ]);
  await h.db.insert(clanMembers).values([
    {
      clanId: PUBLIC_CLAN_ID,
      // biome-ignore lint/style/noNonNullAssertion: the harness seeds the owner above
      playerId: h.seed.ownerPlayerId!,
      memberRole: 'leader',
    },
    { clanId: PUBLIC_CLAN_ID, playerId: member.id, memberRole: 'member' },
  ]);
  await h.db.insert(matches).values({
    id: MATCH_ID,
    serverId: SERVER_ID,
    map: 'Narva',
    layer: 'Narva RAAS v1',
    winner: 'team1',
    startedAt: new Date('2026-07-10T10:00:00Z'),
    endedAt: new Date('2026-07-10T11:00:00Z'),
    durationSeconds: 3600,
  });
  await h.db.insert(matchPlayers).values({
    matchId: MATCH_ID,
    playerId: member.id,
    joinedAt: new Date('2026-07-10T10:00:00Z'),
    leftAt: new Date('2026-07-10T11:00:00Z'),
    playSeconds: 3600,
  });
  await h.db.insert(playerStatPeriods).values({
    playerId: member.id,
    periodType: 'day',
    periodStart: new Date().toISOString().slice(0, 10),
    onlineSeconds: 3600,
    kills: 4,
    deaths: 2,
    revives: 1,
    matchesPlayed: 1,
  });
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/public/clans', () => {
  it('serves only active clans with public visibility and no session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/v1/public/clans' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: PUBLIC_CLAN_ID,
          name: 'Открытый клан',
          tags: ['PUB'],
          description: 'Публичное описание',
        },
      ],
      total: 1,
    });
  });
});

describeIfDb('GET /api/v1/public/clans/:id', () => {
  it('returns the public page payload without PII or priority fields', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/clans/${PUBLIC_CLAN_ID}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    const payload = JSON.stringify(body).toLowerCase();
    expect(payload).not.toMatch(/steam|eos|priority|last_seen|ip_address/);
    expect(body).toMatchObject({
      id: PUBLIC_CLAN_ID,
      name: 'Открытый клан',
      roster: expect.arrayContaining([{ nickname: 'Публичный участник', role: 'member' }]),
      matches: [{ map: 'Narva', layer: 'Narva RAAS v1', winner: 'team1' }],
    });
    expect(body).not.toHaveProperty('members[0].player_id');
    expect(body).not.toHaveProperty('stats.boost_seconds');
  });

  it('returns 404 for a private clan, without revealing it anonymously', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/clans/${PRIVATE_CLAN_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'clan_not_found' });
  });

  it('closes a page immediately when public visibility is switched off', async () => {
    await h.db.update(clans).set({ isPublic: false }).where(eq(clans.id, PUBLIC_CLAN_ID));
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/clans/${PUBLIC_CLAN_ID}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
