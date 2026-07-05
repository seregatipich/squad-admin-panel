import { clanMembers, clans, matches, matchPlayers, players, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(872001);
const NO_PANEL_STEAM = testSteamId(872099);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let clanId: string;
let serverAId: string;
let serverBId: string;
let memberOne: string;
let memberTwo: string;
let memberThree: string;
let stranger: string;
let matchTwoParticipants: string;
let matchOneParticipant: string;
let matchNoParticipants: string;
let matchSeed: string;
let matchServerB: string;

async function seedPlayer(name: string, steamSeed: number): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSeed),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedServer(name: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id}`,
  });
  return id;
}

async function seedMatch(opts: {
  serverId: string;
  startedAt: Date;
  isSeed?: boolean;
  winner?: 'team1' | 'team2' | 'draw' | null;
  map?: string;
}): Promise<string> {
  const [row] = await h.db
    .insert(matches)
    .values({
      serverId: opts.serverId,
      map: opts.map ?? 'Yehorivka',
      layer: `${opts.map ?? 'Yehorivka'}_RAAS_v1`,
      team1Faction: 'USA',
      team2Faction: 'RUS',
      team1Tickets: 250,
      team2Tickets: 0,
      winner: opts.winner ?? 'team1',
      isSeed: opts.isSeed ?? false,
      startedAt: opts.startedAt,
      endedAt: new Date(opts.startedAt.getTime() + 45 * 60_000),
      durationSeconds: 45 * 60,
    })
    .returning({ id: matches.id });
  if (!row) throw new Error('failed to seed match');
  return row.id;
}

async function seedMatchPlayer(matchId: string, playerId: string, team: 1 | 2): Promise<void> {
  await h.db.insert(matchPlayers).values({
    matchId,
    playerId,
    team,
    joinedAt: new Date('2026-07-01T00:00:00.000Z'),
    playSeconds: 1800,
  });
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
    userAgent: 'clans-matches-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  serverAId = await seedServer('Сервер А');
  serverBId = await seedServer('Сервер Б');

  memberOne = await seedPlayer('Участник 1', 872002);
  memberTwo = await seedPlayer('Участник 2', 872003);
  memberThree = await seedPlayer('Участник 3', 872004);
  stranger = await seedPlayer('Чужой', 872005);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'Без доступа',
    canonicalNameNormalized: 'без доступа',
  });

  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Клан матчей', tags: ['MTC'] });
  await h.db.insert(clanMembers).values([
    { clanId, playerId: memberOne, memberRole: 'leader', hasPriority: true },
    { clanId, playerId: memberTwo, memberRole: 'deputy', hasPriority: false },
    { clanId, playerId: memberThree, memberRole: 'member', hasPriority: false },
  ]);

  matchNoParticipants = await seedMatch({
    serverId: serverAId,
    startedAt: new Date('2026-07-01T10:00:00.000Z'),
    map: 'Narva',
  });
  await seedMatchPlayer(matchNoParticipants, stranger, 1);

  matchOneParticipant = await seedMatch({
    serverId: serverAId,
    startedAt: new Date('2026-07-02T10:00:00.000Z'),
    map: 'Gorodok',
  });
  await seedMatchPlayer(matchOneParticipant, memberOne, 1);
  await seedMatchPlayer(matchOneParticipant, stranger, 2);

  matchTwoParticipants = await seedMatch({
    serverId: serverAId,
    startedAt: new Date('2026-07-03T10:00:00.000Z'),
    winner: 'team2',
    map: 'Mutaha',
  });
  await seedMatchPlayer(matchTwoParticipants, memberOne, 1);
  await seedMatchPlayer(matchTwoParticipants, memberTwo, 2);

  matchSeed = await seedMatch({
    serverId: serverAId,
    startedAt: new Date('2026-07-04T10:00:00.000Z'),
    isSeed: true,
    map: 'Logar',
  });
  await seedMatchPlayer(matchSeed, memberThree, 1);

  matchServerB = await seedMatch({
    serverId: serverBId,
    startedAt: new Date('2026-07-05T10:00:00.000Z'),
    map: 'Fallujah',
  });
  await seedMatchPlayer(matchServerB, memberOne, 1);
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

interface MatchParticipant {
  player_id: string;
  name: string;
  member_role: string;
}
interface ClanMatchItem {
  id: string;
  server_id: string;
  server_name: string | null;
  map: string | null;
  team1_tickets: number | null;
  team2_tickets: number | null;
  winner: string | null;
  is_seed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  clan_participants_count: number;
  participants: MatchParticipant[];
}
interface ClanMatchesResponse {
  clan_id: string;
  items: ClanMatchItem[];
  next_cursor: string | null;
  limit: number;
}

describeIfDb('GET /api/v1/clans/:id/matches', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/clans/${clanId}/matches` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects users without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches`,
      headers: { cookie: await loginAsSteam(NO_PANEL_STEAM) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}/matches`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a soft-deleted clan', async () => {
    const deletedId = uuidv7();
    await h.db.insert(clans).values({ id: deletedId, name: 'Удалён матчи', deletedAt: new Date() });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${deletedId}/matches`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists only matches with clan participation, newest first, with correct counts', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ClanMatchesResponse;
    expect(body.clan_id).toBe(clanId);

    const ids = body.items.map((item) => item.id);
    expect(ids).not.toContain(matchNoParticipants);
    expect(ids).toEqual([matchServerB, matchSeed, matchTwoParticipants, matchOneParticipant]);

    const twoParticipantMatch = body.items.find((item) => item.id === matchTwoParticipants);
    expect(twoParticipantMatch?.clan_participants_count).toBe(2);
    expect(twoParticipantMatch?.participants.map((p) => p.player_id).sort()).toEqual(
      [memberOne, memberTwo].sort(),
    );
    expect(twoParticipantMatch?.winner).toBe('team2');

    const oneParticipantMatch = body.items.find((item) => item.id === matchOneParticipant);
    expect(oneParticipantMatch?.clan_participants_count).toBe(1);
    expect(oneParticipantMatch?.participants[0]?.member_role).toBe('leader');
  });

  it('flags seed matches', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as ClanMatchesResponse;
    const seedMatch = body.items.find((item) => item.id === matchSeed);
    expect(seedMatch?.is_seed).toBe(true);
  });

  it('filters by server_id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches?server_id=${serverBId}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    const body = res.json() as ClanMatchesResponse;
    expect(body.items.map((item) => item.id)).toEqual([matchServerB]);
  });

  it('paginates with a stable keyset cursor', async () => {
    const cookie = await loginAsOwner(h);
    const firstPage = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches?limit=2`,
      headers: { cookie },
    });
    const first = firstPage.json() as ClanMatchesResponse;
    expect(first.items.map((item) => item.id)).toEqual([matchServerB, matchSeed]);
    expect(first.next_cursor).not.toBeNull();

    const secondPage = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches?limit=2&cursor=${encodeURIComponent(
        first.next_cursor ?? '',
      )}`,
      headers: { cookie },
    });
    const second = secondPage.json() as ClanMatchesResponse;
    expect(second.items.map((item) => item.id)).toEqual([
      matchTwoParticipants,
      matchOneParticipant,
    ]);
    expect(second.next_cursor).toBeNull();
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/matches?cursor=not-a-cursor`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(400);
  });
});
