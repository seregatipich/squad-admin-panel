import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VEHICLE_CATALOG_SEED } from '../src/schema/vehicle-catalog.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMBAT_SQL = readFileSync(path.resolve(__dirname, '../sql/combat-events.sql'), 'utf-8');
const CATALOG_SQL = readFileSync(path.resolve(__dirname, '../sql/vehicle-catalog.sql'), 'utf-8');

const SCHEMA = 'vehicle_catalog_dbtest';
const SERVER_ID = '000000e1-0000-4000-8000-0000000000e1';

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await sql.unsafe(`SET search_path TO ${SCHEMA}, public`);
  await sql.unsafe(COMBAT_SQL);
  await sql.unsafe(CATALOG_SQL);

  await sql`
    INSERT INTO servers (id, display_name, slug) VALUES
      (${SERVER_ID}, 'vehicle-cat-srv', 'vehicle-cat-srv')
    ON CONFLICT (id) DO NOTHING
  `;

  for (const asset of VEHICLE_CATALOG_SEED) {
    await sql`
      INSERT INTO vehicle_catalog (asset_id, name_en, name_ru, vehicle_class)
      VALUES (${asset.assetId}, ${asset.nameEn}, ${asset.nameRu}, ${asset.vehicleClass})
      ON CONFLICT (asset_id) DO NOTHING
    `;
  }
}, 60_000);

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql`DELETE FROM servers WHERE id = ${SERVER_ID}`;
  await sql.end({ timeout: 5 });
});

describeIfDb('vehicle_catalog seed', () => {
  it('materializes the localization catalog with EN/RU names and a class', async () => {
    const [row] = await sql<{ name_en: string; name_ru: string; vehicle_class: string }[]>`
      SELECT name_en, name_ru, vehicle_class FROM vehicle_catalog WHERE asset_id = 'T72B3'
    `;
    expect(row.name_en).toBe('T-72B3');
    expect(row.name_ru).toBe('Т-72Б3');
    expect(row.vehicle_class).toBe('MBT');
  });

  it('seeds every catalog entry from the shared constant', async () => {
    const [{ count }] = await sql<
      { count: string }[]
    >`SELECT count(*)::int AS count FROM vehicle_catalog`;
    expect(Number(count)).toBe(VEHICLE_CATALOG_SEED.length);
  });
});

describeIfDb('combat_events vehicle rows', () => {
  it('accepts a vehicle_destroyed row with a NULL victim player and a raw victim_vehicle', async () => {
    await sql`
      INSERT INTO combat_events
        (event_type, server_id, attacker_player_id, victim_player_id, victim_vehicle, attacker_vehicle, weapon, occurred_at)
      VALUES
        ('vehicle_destroyed', ${SERVER_ID}, NULL, NULL, 'T72B3', 'BTR82A', 'BP_Projectile_HEAT', date_trunc('month', now()))
    `;
    const [row] = await sql<{ victim_player_id: string | null; victim_vehicle: string }[]>`
      SELECT victim_player_id, victim_vehicle FROM combat_events
      WHERE event_type = 'vehicle_destroyed' AND victim_vehicle = 'T72B3'
    `;
    expect(row.victim_player_id).toBeNull();
    expect(row.victim_vehicle).toBe('T72B3');
  });

  it('writes a vehicle_destroyed row even when the asset_id is unknown to the catalog', async () => {
    const [{ known }] = await sql<{ known: string }[]>`
      SELECT count(*)::int AS known FROM vehicle_catalog WHERE asset_id = 'MysteryHovercraft'
    `;
    expect(Number(known)).toBe(0);
    await sql`
      INSERT INTO combat_events
        (event_type, server_id, attacker_player_id, victim_player_id, victim_vehicle, occurred_at)
      VALUES
        ('vehicle_destroyed', ${SERVER_ID}, NULL, NULL, 'MysteryHovercraft', date_trunc('month', now()))
    `;
    const [row] = await sql<{ victim_vehicle: string }[]>`
      SELECT victim_vehicle FROM combat_events WHERE victim_vehicle = 'MysteryHovercraft'
    `;
    expect(row.victim_vehicle).toBe('MysteryHovercraft');
  });

  it('still rejects an event_type outside the extended CHECK set', async () => {
    await expect(
      sql`
        INSERT INTO combat_events
          (event_type, server_id, victim_player_id, occurred_at)
        VALUES
          ('teleport', ${SERVER_ID}, NULL, date_trunc('month', now()))
      `,
    ).rejects.toThrow();
  });
});
