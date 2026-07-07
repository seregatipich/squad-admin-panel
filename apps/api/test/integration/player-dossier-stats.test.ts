import {
  players,
  playerVehicleKills,
  playerVehicleStats,
  playerWeaponStats,
} from '@squad/db/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000991n;

let h: IntegrationHarness;
let playerId: string;

afterEach(async () => {
  if (h) await h.cleanup();
});

async function seedPlayer(): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: 76561198000000123n,
      canonicalName: 'DossierPlayer',
      canonicalNameNormalized: 'dossierplayer',
      eosId: 'eos-dossier',
    })
    .returning({ id: players.id });
  return row.id;
}

describe('GET /api/v1/players/:playerId/weapon-stats', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
    });
    playerId = await seedPlayer();
    await h.db.insert(playerWeaponStats).values([
      {
        playerId,
        weapon: 'BP_AK74',
        kills: 12,
        teamkills: 1,
        damage: '540.5',
        shotsEvents: 30,
        lastUsedAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        playerId,
        weapon: 'BP_Knife',
        kills: 3,
        teamkills: 0,
        damage: null,
        shotsEvents: 0,
        lastUsedAt: null,
      },
    ]);
  });

  it('returns weapon aggregates sorted by kills desc, with null damage preserved', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/weapon-stats`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      weapons: { weapon: string; kills: number; damage: number | null; shots_events: number }[];
    };
    expect(body.weapons).toHaveLength(2);
    expect(body.weapons[0]).toMatchObject({
      weapon: 'BP_AK74',
      kills: 12,
      damage: 540.5,
      shots_events: 30,
    });
    expect(body.weapons[1]).toMatchObject({ weapon: 'BP_Knife', kills: 3, damage: null });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/weapon-stats`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/players/:playerId/vehicle-stats', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
    });
    playerId = await seedPlayer();
    await h.db.insert(playerVehicleStats).values([
      { playerId, vehicleAssetId: 'BTR82A', kills: 5, damage: '320' },
      { playerId, vehicleAssetId: 'T72B3', kills: 2, damage: null },
    ]);
    await h.db.insert(playerVehicleKills).values([
      { playerId, victimVehicleAssetId: 'M1A2', weapon: 'BP_RPG7', destroyedCount: 4 },
      { playerId, victimVehicleAssetId: 'LAV25', weapon: 'BP_AT4', destroyedCount: 1 },
    ]);
  });

  it('returns both the from-vehicle stats and the vehicle-destruction breakdown', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/vehicle-stats`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      from_vehicle: { vehicle_asset_id: string; kills: number; damage: number | null }[];
      destroyed: { victim_vehicle_asset_id: string; weapon: string; destroyed_count: number }[];
    };
    expect(body.from_vehicle[0]).toMatchObject({
      vehicle_asset_id: 'BTR82A',
      kills: 5,
      damage: 320,
    });
    expect(body.from_vehicle.find((v) => v.vehicle_asset_id === 'T72B3')?.damage).toBeNull();
    expect(body.destroyed[0]).toMatchObject({
      victim_vehicle_asset_id: 'M1A2',
      weapon: 'BP_RPG7',
      destroyed_count: 4,
    });
  });
});
