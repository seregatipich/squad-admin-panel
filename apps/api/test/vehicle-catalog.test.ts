import type { DatabaseClient } from '@squad/db';
import { players, roles, vehicleCatalog } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198200000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 5_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

const TEST_ASSET = `TestRig_${Date.now().toString(36)}`;

async function seedRole(
  db: DatabaseClient,
  opts: { panelAccess: boolean; combatView: boolean },
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `VehRole-${id.slice(0, 12)}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess,
    combatView: opts.combatView,
  });
  return id;
}

async function seedPlayer(db: DatabaseClient, roleId: string | null): Promise<string> {
  const id = uuidv7();
  const name = `VehUser-${id.slice(0, 8)}`;
  await db.insert(players).values({
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
    userAgent: 'vehicle-catalog-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

describeIfDb('vehicle-catalog API (DOSSIER-1)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);
  });

  afterAll(async () => {
    await h.db.delete(vehicleCatalog).where(eq(vehicleCatalog.assetId, TEST_ASSET));
    await h.cleanup();
  });

  it('lists the seeded localization catalog for a combat:view reader', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-catalog',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ asset_id: string; name_ru: string }> };
    const t72 = body.rows.find((row) => row.asset_id === 'T72B3');
    expect(t72?.name_ru).toBe('Т-72Б3');
  });

  it('rejects an unauthenticated read with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/vehicle-catalog' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 on read for a role without combat:view', async () => {
    const role = await seedRole(h.db, { panelAccess: false, combatView: false });
    const player = await seedPlayer(h.db, role);
    const cookie = await loginAs(h, player);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-catalog',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 on write for a role without the config-edit right', async () => {
    const role = await seedRole(h.db, { panelAccess: false, combatView: false });
    const player = await seedPlayer(h.db, role);
    const cookie = await loginAs(h, player);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-catalog/${TEST_ASSET}`,
      headers: { cookie },
      payload: { name_en: 'x', name_ru: 'x', vehicle_class: 'IFV' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ required: 'config:edit' });
  });

  it('upserts a new catalog entry and writes an audit row with before/after', async () => {
    const create = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-catalog/${TEST_ASSET}`,
      headers: { cookie: ownerCookie },
      payload: { name_en: 'Test Rig', name_ru: 'Тестовая техника', vehicle_class: 'IFV' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toMatchObject({
      asset_id: TEST_ASSET,
      name_ru: 'Тестовая техника',
      icon: null,
    });

    const createdAudit = await assertAuditRow(h, {
      action: 'vehicle_catalog.upsert',
      resource: 'vehicle_catalog',
      targetId: TEST_ASSET,
    });
    expect(createdAudit.beforeSnapshot).toBeNull();
    expect(createdAudit.afterSnapshot).toMatchObject({ name_ru: 'Тестовая техника' });

    const update = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-catalog/${TEST_ASSET}`,
      headers: { cookie: ownerCookie },
      payload: {
        name_en: 'Test Rig II',
        name_ru: 'Тестовая техника 2',
        vehicle_class: 'MBT',
        icon: 'tank',
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ name_ru: 'Тестовая техника 2', icon: 'tank' });

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-catalog',
      headers: { cookie: ownerCookie },
    });
    const rows = (list.json() as { rows: Array<{ asset_id: string; vehicle_class: string }> }).rows;
    expect(rows.find((row) => row.asset_id === TEST_ASSET)?.vehicle_class).toBe('MBT');
  });
});
