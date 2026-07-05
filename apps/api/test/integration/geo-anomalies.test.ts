import {
  GEOIP_SETTINGS_SINGLETON_ID,
  geoipSettings,
  playerIpHistory,
  players,
  roles,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(913001);
const NO_PANEL_STEAM = testSteamId(913002);
const HOUR_MS = 3_600_000;

let h: IntegrationHarness;
let anomalyPlayerId: string;
let noPanelCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface AnomaliesResponse {
  config: { country_switch_window_hours: number; multi_country_threshold: number };
  distinct_country_count: number;
  multi_country: boolean;
  has_recent_switch: boolean;
  switches: Array<{
    from_country_code: string;
    to_country_code: string;
    gap_hours: number;
    within_window: boolean;
  }>;
  distinct_countries: Array<{ country_code: string; observation_count: number }>;
  points: Array<{ ip: string; latitude: number; longitude: number }>;
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

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
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
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  await h.db
    .insert(geoipSettings)
    .values({
      id: GEOIP_SETTINGS_SINGLETON_ID,
      enabled: true,
      countrySwitchWindowHours: 24,
      multiCountryThreshold: 3,
    })
    .onConflictDoUpdate({
      target: geoipSettings.id,
      set: { countrySwitchWindowHours: 24, multiCountryThreshold: 3 },
    });

  const noPanelRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: noPanelRoleId,
    name: 'GeoNoPanel',
    color: '#556677',
    panelAccess: false,
  });
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'Без панели',
    canonicalNameNormalized: 'без панели',
    roleId: noPanelRoleId,
  });

  anomalyPlayerId = await seedPlayer('Гео аномалия', 913003);
  const now = Date.now();
  await h.db.insert(playerIpHistory).values([
    {
      playerId: anomalyPlayerId,
      ip: '5.10.20.30',
      countryCode: 'FR',
      countryName: 'France',
      latitude: 48.85,
      longitude: 2.35,
      firstSeenAt: new Date(now - 80 * HOUR_MS),
      lastSeenAt: new Date(now - 80 * HOUR_MS),
    },
    {
      playerId: anomalyPlayerId,
      ip: '6.11.21.31',
      countryCode: 'US',
      countryName: 'United States',
      latitude: 40.71,
      longitude: -74.0,
      firstSeenAt: new Date(now - 40 * HOUR_MS),
      lastSeenAt: new Date(now - 40 * HOUR_MS),
    },
    {
      playerId: anomalyPlayerId,
      ip: '7.12.22.32',
      countryCode: 'DE',
      countryName: 'Germany',
      latitude: 52.52,
      longitude: 13.4,
      firstSeenAt: new Date(now - 6 * HOUR_MS),
      lastSeenAt: new Date(now - 6 * HOUR_MS),
    },
    {
      playerId: anomalyPlayerId,
      ip: '8.13.23.33',
      countryCode: 'RU',
      countryName: 'Russia',
      latitude: 55.75,
      longitude: 37.62,
      firstSeenAt: new Date(now),
      lastSeenAt: new Date(now),
    },
  ]);

  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM, 'geo-nopanel');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/players/:playerId/geo-anomalies', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${anomalyPlayerId}/geo-anomalies`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects panel-less users with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${anomalyPlayerId}/geo-anomalies`,
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns country switches, the multi-country flag and map points for an owner', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${anomalyPlayerId}/geo-anomalies`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnomaliesResponse;

    expect(body.config.country_switch_window_hours).toBe(24);
    expect(body.config.multi_country_threshold).toBe(3);
    expect(body.distinct_country_count).toBe(4);
    expect(body.multi_country).toBe(true);
    expect(body.has_recent_switch).toBe(true);

    const recent = body.switches.find((entry) => entry.within_window);
    expect(recent).toBeDefined();
    expect(recent?.from_country_code).toBe('DE');
    expect(recent?.to_country_code).toBe('RU');
    expect(body.switches.filter((entry) => entry.within_window)).toHaveLength(1);

    expect(body.points).toHaveLength(4);
    expect(body.points.every((point) => Number.isFinite(point.latitude))).toBe(true);
  });

  it('returns an empty, non-flagged result for a player with no ip history', async () => {
    const emptyPlayerId = await seedPlayer('Без гео', 913004);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${emptyPlayerId}/geo-anomalies`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnomaliesResponse;
    expect(body.distinct_country_count).toBe(0);
    expect(body.multi_country).toBe(false);
    expect(body.switches).toHaveLength(0);
  });
});

describeIfDb('GET /api/v1/geo-anomalies feed', () => {
  it('rejects panel-less users with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/geo-anomalies',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('surfaces the anomalous player in the global feed', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/geo-anomalies',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ player_id: string; multi_country: boolean }> };
    const entry = body.items.find((item) => item.player_id === anomalyPlayerId);
    expect(entry).toBeDefined();
    expect(entry?.multi_country).toBe(true);
  });
});
