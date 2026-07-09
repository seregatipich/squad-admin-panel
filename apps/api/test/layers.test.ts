import { layers, players, roles } from '@squad/db/schema';
import { inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import { buildIntegrationApp, type IntegrationHarness } from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198300000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 5_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

// Unique test-range layer names so this suite never collides with the static
// fallback dataset seeded by migration 0042, nor with parallel test runs
// sharing the DB via test:cov.
const RUN_TAG = Date.now().toString(36);
const NAMES = {
  raasA: `TestLayer_RaasA_${RUN_TAG}`,
  raasB: `TestLayer_RaasB_${RUN_TAG}`,
  invasion: `TestLayer_Invasion_${RUN_TAG}`,
  seed: `TestLayer_Seed_${RUN_TAG}`,
};
const TEST_LAYER_IDS: string[] = [];

async function seedRole(h: IntegrationHarness, opts: { panelAccess: boolean }): Promise<string> {
  const id = uuidv7();
  await h.db.insert(roles).values({
    id,
    name: `LayersRole-${id}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess,
  });
  return id;
}

async function seedPlayer(h: IntegrationHarness, roleId: string | null): Promise<string> {
  const id = uuidv7();
  const name = `LayersUser-${id.slice(0, 8)}`;
  await h.db.insert(players).values({
    id,
    steamId64: nextSteam(),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId,
  });
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'layers-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

describeIfDb('layers API (ROT-1)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);

    const rows = [
      {
        id: uuidv7(),
        name: NAMES.raasA,
        map: 'TestMap_Alpha',
        gamemode: 'RAAS',
        version: 'v1',
        isSeed: false,
        teams: { team1: { faction: 'USA' }, team2: { faction: 'RGF' } },
        depotVersion: 'test-depot',
      },
      {
        id: uuidv7(),
        name: NAMES.raasB,
        map: 'TestMap_Alpha',
        gamemode: 'RAAS',
        version: 'v2',
        isSeed: false,
        teams: { team1: { faction: 'USA' }, team2: { faction: 'RGF' } },
        depotVersion: 'test-depot',
      },
      {
        id: uuidv7(),
        name: NAMES.invasion,
        map: 'TestMap_Bravo',
        gamemode: 'Invasion',
        version: 'v1',
        isSeed: false,
        teams: { team1: { faction: 'MEA' }, team2: { faction: 'INS' } },
        depotVersion: 'test-depot',
      },
      {
        id: uuidv7(),
        name: NAMES.seed,
        map: 'TestMap_Alpha',
        gamemode: 'Seed',
        version: 'v1',
        isSeed: true,
        teams: {},
        depotVersion: 'test-depot',
      },
    ];
    TEST_LAYER_IDS.push(...rows.map((row) => row.id));
    await h.db.insert(layers).values(rows);
  });

  afterAll(async () => {
    await h.db.delete(layers).where(inArray(layers.id, TEST_LAYER_IDS));
    await h.cleanup();
  });

  it('rejects an unauthenticated read with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/layers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a role without panel:access', async () => {
    const role = await seedRole(h, { panelAccess: false });
    const player = await seedPlayer(h, role);
    const cookie = await loginAs(h, player);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/layers',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists all layers for a panel:access reader', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/layers',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(Object.values(NAMES)));
  });

  it('serializes teams, is_seed, depot_version and deprecated', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/layers',
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as {
      rows: Array<{
        name: string;
        is_seed: boolean;
        deprecated: boolean;
        depot_version: string | null;
        teams: { team1?: { faction: string } };
      }>;
    };
    const raasA = body.rows.find((row) => row.name === NAMES.raasA);
    expect(raasA).toMatchObject({
      is_seed: false,
      deprecated: false,
      depot_version: 'test-depot',
      teams: { team1: { faction: 'USA' } },
    });
  });

  it('filters by map', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/layers?map=${encodeURIComponent('TestMap_Bravo')}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toContain(NAMES.invasion);
    expect(names).not.toContain(NAMES.raasA);
    expect(names).not.toContain(NAMES.raasB);
    expect(names).not.toContain(NAMES.seed);
  });

  it('filters by gamemode', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/layers?gamemode=RAAS',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([NAMES.raasA, NAMES.raasB]));
    expect(names).not.toContain(NAMES.invasion);
    expect(names).not.toContain(NAMES.seed);
  });

  it('filters by is_seed', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/layers?is_seed=true',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toContain(NAMES.seed);
    expect(names).not.toContain(NAMES.raasA);
    expect(names).not.toContain(NAMES.raasB);
    expect(names).not.toContain(NAMES.invasion);
  });

  it('ANDs multiple filters together (map + gamemode)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/layers?map=${encodeURIComponent('TestMap_Alpha')}&gamemode=RAAS`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([NAMES.raasA, NAMES.raasB]));
    expect(names).not.toContain(NAMES.invasion);
    expect(names).not.toContain(NAMES.seed);
  });

  it('ANDs map + gamemode + is_seed down to a single row', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/layers?map=${encodeURIComponent('TestMap_Alpha')}&gamemode=Seed&is_seed=true`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ name: string }> };
    const names = body.rows.map((row) => row.name);
    expect(names).toEqual([NAMES.seed]);
  });
});
