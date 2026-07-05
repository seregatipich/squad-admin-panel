import { clanMembers, clans, playerSessions, players, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(871001);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let clanId: string;
let serverAId: string;
let serverBId: string;
let onlineA1: string;
let onlineA2: string;
let onlineB1: string;
let offlineMember: string;

async function seedPlayer(name: string, steamSeed: number): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSeed),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
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

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  serverAId = await seedServer('Сервер А');
  serverBId = await seedServer('Сервер Б');

  onlineA1 = await seedPlayer('Онлайн А1', 871002);
  onlineA2 = await seedPlayer('Онлайн А2', 871003);
  onlineB1 = await seedPlayer('Онлайн Б1', 871004);
  offlineMember = await seedPlayer('Оффлайн', 871005);
  const strangerOnline = await seedPlayer('Чужой', 871006);

  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Клан онлайн', tags: ['ONL'] });
  await h.db.insert(clanMembers).values([
    { clanId, playerId: onlineA1, memberRole: 'leader', hasPriority: true },
    { clanId, playerId: onlineA2, memberRole: 'member', hasPriority: false },
    { clanId, playerId: onlineB1, memberRole: 'deputy', hasPriority: false },
    { clanId, playerId: offlineMember, memberRole: 'member', hasPriority: false },
  ]);

  await h.db.insert(playerSessions).values([
    {
      playerId: onlineA1,
      serverId: serverAId,
      connectedAt: new Date('2026-07-05T10:00:00.000Z'),
      disconnectedAt: null,
    },
    {
      playerId: onlineA2,
      serverId: serverAId,
      connectedAt: new Date('2026-07-05T10:05:00.000Z'),
      disconnectedAt: null,
    },
    {
      playerId: onlineB1,
      serverId: serverBId,
      connectedAt: new Date('2026-07-05T09:30:00.000Z'),
      disconnectedAt: null,
    },
    {
      playerId: offlineMember,
      serverId: serverAId,
      connectedAt: new Date('2026-07-05T08:00:00.000Z'),
      disconnectedAt: new Date('2026-07-05T09:00:00.000Z'),
    },
    {
      playerId: strangerOnline,
      serverId: serverAId,
      connectedAt: new Date('2026-07-05T10:10:00.000Z'),
      disconnectedAt: null,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

interface OnlineMember {
  player_id: string;
  name: string;
  team: string | null;
  squad: string | null;
  session_started_at: string;
}
interface OnlineServer {
  server_id: string;
  server_name: string;
  server_slug: string;
  members: OnlineMember[];
}
interface OnlineResponse {
  clan_id: string;
  servers: OnlineServer[];
}

describeIfDb('GET /api/v1/clans/:id/online', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/clans/${clanId}/online` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}/online`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('groups online clan members by server and excludes offline members and non-members', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/online`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OnlineResponse;
    expect(body.clan_id).toBe(clanId);
    expect(body.servers).toHaveLength(2);

    const groupA = body.servers.find((s) => s.server_id === serverAId);
    const groupB = body.servers.find((s) => s.server_id === serverBId);
    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();

    const idsA = groupA?.members.map((m) => m.player_id).sort();
    expect(idsA).toEqual([onlineA1, onlineA2].sort());
    expect(groupB?.members.map((m) => m.player_id)).toEqual([onlineB1]);

    const everyId = body.servers.flatMap((s) => s.members.map((m) => m.player_id));
    expect(everyId).not.toContain(offlineMember);

    const firstA = groupA?.members.find((m) => m.player_id === onlineA1);
    expect(firstA?.name).toBe('Онлайн А1');
    expect(firstA?.session_started_at).toBe('2026-07-05T10:00:00.000Z');
    expect(firstA?.team).toBeNull();
    expect(firstA?.squad).toBeNull();
  });

  it('returns an empty server list when no members are online', async () => {
    const emptyClanId = uuidv7();
    await h.db.insert(clans).values({ id: emptyClanId, name: 'Пустой клан' });
    const loneMember = await seedPlayer('Одиночка', 871007);
    await h.db
      .insert(clanMembers)
      .values({ clanId: emptyClanId, playerId: loneMember, memberRole: 'leader' });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${emptyClanId}/online`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OnlineResponse;
    expect(body.servers).toEqual([]);
  });

  it('rejects a soft-deleted clan with 404', async () => {
    const deletedId = uuidv7();
    await h.db.insert(clans).values({ id: deletedId, name: 'Удалён', deletedAt: new Date() });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${deletedId}/online`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });
});
