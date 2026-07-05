import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../src/client.js';
import { recordIpObservation } from '../src/geoip/observe.js';
import type { GeoFields } from '../src/geoip/resolver.js';
import * as schema from '../src/schema/index.js';
import { playerIpHistory, players } from '../src/schema/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_ID = '000000c3-0000-4000-8000-000000000000';

const BERLIN_GEO: GeoFields = {
  countryCode: 'DE',
  countryName: 'Germany',
  region: 'Berlin',
  city: 'Berlin',
  timezoneOffset: 'Europe/Berlin',
  latitude: 52.52,
  longitude: 13.405,
};

const PARIS_GEO: GeoFields = {
  countryCode: 'FR',
  countryName: 'France',
  region: 'Île-de-France',
  city: 'Paris',
  timezoneOffset: 'Europe/Paris',
  latitude: 48.85,
  longitude: 2.35,
};

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;

async function rowFor(ip: string) {
  const rows = await db
    .select()
    .from(playerIpHistory)
    .where(eq(playerIpHistory.playerId, PLAYER_ID));
  return rows.find((r) => String(r.ip) === ip);
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(async () => {
  if (!DATABASE_URL) return;
  const nick = `geoip-${randomBytes(4).toString('hex')}`;
  await sql`DELETE FROM player_ip_history WHERE player_id = ${PLAYER_ID}`;
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized, eos_id, last_known_ip)
    VALUES (${PLAYER_ID}, ${nick}, ${nick}, ${`eos-${nick}`}, NULL)
    ON CONFLICT (id) DO UPDATE SET last_known_ip = NULL
  `;
});

describeIfDb('recordIpObservation', () => {
  it('inserts a new row with frozen geo and updates players.last_known_ip', async () => {
    await recordIpObservation(db, {
      playerId: PLAYER_ID,
      ip: '203.0.113.10',
      geo: BERLIN_GEO,
      observedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const row = await rowFor('203.0.113.10');
    expect(row).toBeDefined();
    expect(row?.observationCount).toBe(1);
    expect(row?.countryCode).toBe('DE');
    expect(row?.city).toBe('Berlin');
    expect(Number(row?.latitude)).toBeCloseTo(52.52);

    const [player] = await db
      .select({ ip: players.lastKnownIp })
      .from(players)
      .where(eq(players.id, PLAYER_ID));
    expect(String(player?.ip)).toBe('203.0.113.10');
  });

  it('increments observation_count on repeat IP without creating a duplicate row', async () => {
    await recordIpObservation(db, {
      playerId: PLAYER_ID,
      ip: '203.0.113.20',
      geo: BERLIN_GEO,
      observedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await recordIpObservation(db, {
      playerId: PLAYER_ID,
      ip: '203.0.113.20',
      geo: BERLIN_GEO,
      observedAt: new Date('2026-02-01T00:00:00Z'),
    });

    const rows = await db
      .select()
      .from(playerIpHistory)
      .where(eq(playerIpHistory.playerId, PLAYER_ID));
    const forIp = rows.filter((r) => String(r.ip) === '203.0.113.20');
    expect(forIp).toHaveLength(1);
    expect(forIp[0]?.observationCount).toBe(2);
    expect(forIp[0]?.lastSeenAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(forIp[0]?.firstSeenAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('freezes geo at first observation even if a later resolve returns different geo', async () => {
    await recordIpObservation(db, {
      playerId: PLAYER_ID,
      ip: '203.0.113.30',
      geo: BERLIN_GEO,
    });
    await recordIpObservation(db, {
      playerId: PLAYER_ID,
      ip: '203.0.113.30',
      geo: PARIS_GEO,
    });

    const row = await rowFor('203.0.113.30');
    expect(row?.countryCode).toBe('DE');
    expect(row?.city).toBe('Berlin');
    expect(row?.observationCount).toBe(2);
  });

  it('records the observation with null geo when no MaxMind key is configured', async () => {
    await recordIpObservation(db, { playerId: PLAYER_ID, ip: '203.0.113.40' });

    const row = await rowFor('203.0.113.40');
    expect(row).toBeDefined();
    expect(row?.countryCode).toBeNull();
    expect(row?.city).toBeNull();
    expect(row?.latitude).toBeNull();
    expect(row?.observationCount).toBe(1);
  });
});
