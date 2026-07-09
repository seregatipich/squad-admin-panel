import { matches, playerDailyPresence, playerSessions, players, servers } from '@squad/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

const SERVER_A = '019e0000-0000-7000-9000-0000000000a1';
const SERVER_B = '019e0000-0000-7000-9000-0000000000b2';

const WINDOW_FROM = '2026-06-01T00:00:00.000Z';
const WINDOW_TO = '2026-06-02T00:00:00.000Z';

let h: IntegrationHarness;
let playerA1: string;
let playerA2: string;
let playerB1: string;

interface PublicStatsBody {
  from: string;
  to: string;
  summary: {
    total_matches: number;
    total_online_hours: number;
    unique_players: number;
    avg_match_duration_seconds: number | null;
  };
  peak_by_hour: Array<{ hour: number; peak_players: number }>;
  match_outcomes: {
    team1: number;
    team2: number;
    draw: number;
    unknown: number;
    total: number;
  };
  popular_maps: Array<{ map: string; matches: number }>;
  popular_layers: Array<{ layer: string; matches: number }>;
}

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function fetchPublicStats(query: string) {
  return h.app.inject({ method: 'GET', url: `/api/v1/public/stats${query}` });
}

async function seedPlayer(steamSuffix: number, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSuffix),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ bridge: makeFakeBridge() });

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Server A', slug: 'server-a' },
    { id: SERVER_B, displayName: 'Server B', slug: 'server-b' },
  ]);

  playerA1 = await seedPlayer(830010, 'PublicStatsA1');
  playerA2 = await seedPlayer(830011, 'PublicStatsA2');
  playerB1 = await seedPlayer(830012, 'PublicStatsB1');

  await h.db.insert(matches).values([
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-01T08:00:00Z'),
      durationSeconds: 1800,
    },
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_RAAS_v1',
      winner: 'team2',
      startedAt: new Date('2026-06-01T09:00:00Z'),
      durationSeconds: 2400,
    },
    {
      serverId: SERVER_A,
      map: 'Gorodok',
      layer: 'Gorodok_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-01T10:00:00Z'),
      durationSeconds: 1200,
    },
    {
      serverId: SERVER_B,
      map: 'Yehorivka',
      layer: 'Yehorivka_AAS_v1',
      winner: 'draw',
      startedAt: new Date('2026-06-01T11:00:00Z'),
      durationSeconds: 3000,
    },
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-05T08:00:00Z'),
      durationSeconds: 1800,
    },
  ]);

  await h.db.insert(playerSessions).values([
    {
      playerId: playerA1,
      serverId: SERVER_A,
      connectedAt: new Date('2026-06-01T09:30:00Z'),
      disconnectedAt: new Date('2026-06-01T11:15:00Z'),
    },
    {
      playerId: playerA2,
      serverId: SERVER_A,
      connectedAt: new Date('2026-06-01T10:00:00Z'),
      disconnectedAt: new Date('2026-06-01T10:50:00Z'),
    },
    {
      playerId: playerB1,
      serverId: SERVER_B,
      connectedAt: new Date('2026-06-01T10:15:00Z'),
      disconnectedAt: new Date('2026-06-01T11:40:00Z'),
    },
  ]);

  await h.db.insert(playerDailyPresence).values([
    { playerId: playerA1, day: '2026-06-01', serverId: SERVER_A, onlineSeconds: 3600 },
    { playerId: playerA2, day: '2026-06-01', serverId: SERVER_A, onlineSeconds: 7200 },
    { playerId: playerB1, day: '2026-06-01', serverId: SERVER_B, onlineSeconds: 1800 },
  ]);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/public/stats', () => {
  it('serves 200 with no session cookie or auth header at all', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/stats?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('aggregates matches, outcomes and popular maps/layers across all servers', async () => {
    const res = await fetchPublicStats(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as PublicStatsBody;

    expect(body.summary.total_matches).toBe(4);
    expect(body.match_outcomes).toEqual({ team1: 2, team2: 1, draw: 1, unknown: 0, total: 4 });
    expect(body.popular_maps).toEqual(
      expect.arrayContaining([
        { map: 'Narva', matches: 2 },
        { map: 'Gorodok', matches: 1 },
        { map: 'Yehorivka', matches: 1 },
      ]),
    );
    expect(body.popular_layers.map((l) => l.layer)).toEqual(
      expect.arrayContaining([
        'Narva_AAS_v1',
        'Narva_RAAS_v1',
        'Gorodok_AAS_v1',
        'Yehorivka_AAS_v1',
      ]),
    );
  });

  it('computes peak concurrent players by hour-of-day and online hours', async () => {
    const res = await fetchPublicStats(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as PublicStatsBody;

    expect(body.peak_by_hour).toHaveLength(24);
    const byHour = new Map(body.peak_by_hour.map((entry) => [entry.hour, entry.peak_players]));
    expect(byHour.get(10)).toBe(2);
    expect(byHour.get(11)).toBe(2);
    expect(byHour.get(9)).toBe(0);

    expect(body.summary.unique_players).toBe(3);
    expect(body.summary.total_online_hours).toBe(3.5);
  });

  it('excludes matches outside the requested window', async () => {
    const res = await fetchPublicStats(
      '?from=2026-06-04T00:00:00.000Z&to=2026-06-06T00:00:00.000Z',
    );
    const body = res.json() as PublicStatsBody;
    expect(body.summary.total_matches).toBe(1);
    expect(body.match_outcomes.team1).toBe(1);
  });

  it('does not include any server_id, steamId, or player-name fields anywhere in the payload', async () => {
    const res = await fetchPublicStats(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const raw = res.body;
    expect(raw).not.toMatch(/steam/i);
    expect(raw).not.toContain('server_id');
    expect(raw).not.toContain(SERVER_A);
    expect(raw).not.toContain(SERVER_B);
    expect(raw).not.toContain('PublicStatsA1');
    expect(raw).not.toContain('PublicStatsA2');
    expect(raw).not.toContain('PublicStatsB1');

    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('server_id');
  });

  it('exports CSV with a stable long-format shape via ?format=csv', async () => {
    const res = await fetchPublicStats(`?from=${WINDOW_FROM}&to=${WINDOW_TO}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('public-stats.csv');

    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('section,key,value');
    expect(rows).toContain('summary,total_matches,4');
    expect(rows.filter((r) => r.startsWith('peak_by_hour,'))).toHaveLength(24);
  });

  it('exports CSV from the dedicated /api/v1/public/stats.csv path', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/public/stats.csv?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('section,key,value');
  });
});
