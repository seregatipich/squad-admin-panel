import { playerIpHistory, playerSessions, players, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(872001);
const DAY_MS = 86_400_000;
const EVENING_DAYS = 10;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let serverId: string;
let tokyoPlayerId: string;
let noGeoPlayerId: string;

interface PrimetimeResponse {
  window: { from: string; to: string; days: number };
  timezone: string | null;
  offset_minutes: number;
  total_seconds: number;
  histogram: number[];
  rolling_average: number[];
  primetime: {
    label: string;
    start_minutes: number;
    end_minutes: number;
    start_hour: number;
    end_hour: number;
  } | null;
}

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

function eveningSessionValues(playerId: string) {
  const midnightNow = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return Array.from({ length: EVENING_DAYS }, (_, index) => {
    const base = midnightNow - (index + 1) * DAY_MS;
    return {
      playerId,
      serverId,
      connectedAt: new Date(base + 18 * 3_600_000),
      disconnectedAt: new Date(base + 21 * 3_600_000),
    };
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Праймтайм-сервер',
    slug: `primetime-${serverId}`,
  });

  tokyoPlayerId = await seedPlayer('Токио игрок', 872002);
  noGeoPlayerId = await seedPlayer('Без гео', 872003);

  await h.db
    .insert(playerSessions)
    .values([...eveningSessionValues(tokyoPlayerId), ...eveningSessionValues(noGeoPlayerId)]);

  await h.db.insert(playerIpHistory).values({
    playerId: tokyoPlayerId,
    ip: '203.0.113.10',
    timezoneOffset: 'Asia/Tokyo',
    lastSeenAt: new Date(),
  });
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/players/:playerId/primetime', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${tokyoPlayerId}/primetime`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('buckets evening sessions and shifts them by the geoip timezone offset', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${tokyoPlayerId}/primetime`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrimetimeResponse;

    expect(body.timezone).toBe('Asia/Tokyo');
    expect(body.offset_minutes).toBe(540);
    expect(body.histogram).toHaveLength(24);
    expect(body.histogram[3]).toBe(EVENING_DAYS * 3600);
    expect(body.histogram[4]).toBe(EVENING_DAYS * 3600);
    expect(body.histogram[5]).toBe(EVENING_DAYS * 3600);
    expect(body.histogram[18]).toBe(0);
    expect(body.total_seconds).toBe(EVENING_DAYS * 3 * 3600);
    expect(body.primetime).not.toBeNull();
    expect(body.primetime?.label.startsWith('Праймтайм ')).toBe(true);
    expect(body.primetime?.start_hour).toBe(2);
    expect(body.primetime?.end_hour).toBe(6);
  });

  it('falls back to UTC when the player has no geoip timezone', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${noGeoPlayerId}/primetime`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrimetimeResponse;

    expect(body.timezone).toBeNull();
    expect(body.offset_minutes).toBe(0);
    expect(body.histogram[18]).toBe(EVENING_DAYS * 3600);
    expect(body.histogram[19]).toBe(EVENING_DAYS * 3600);
    expect(body.histogram[20]).toBe(EVENING_DAYS * 3600);
    expect(body.primetime?.start_hour).toBe(17);
    expect(body.primetime?.end_hour).toBe(21);
  });
});
