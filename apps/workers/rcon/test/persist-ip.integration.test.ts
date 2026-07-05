import { randomBytes } from 'node:crypto';
import type { DatabaseClient, GeoFields, GeoLookup } from '@squad/db';
import * as schema from '@squad/db/schema';
import { playerIpHistory, players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { upsertPlayers } from '../src/persist.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const BERLIN_GEO: GeoFields = {
  countryCode: 'DE',
  countryName: 'Germany',
  region: 'Berlin',
  city: 'Berlin',
  timezoneOffset: 'Europe/Berlin',
  latitude: 52.52,
  longitude: 13.405,
};

function makePlayer(overrides: Partial<RconPlayer>): RconPlayer {
  return {
    rcon_id: 1,
    eos_id: `eos-ip-${randomBytes(8).toString('hex')}`,
    steam_id64: null,
    name: 'IpTester',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: 'USA_Rifleman_01',
    ...overrides,
  };
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;

async function playerIdByEos(eosId: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.eosId, eosId));
  if (!row) throw new Error(`no player for eos_id=${eosId}`);
  return row.id;
}

beforeAll(() => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
});

afterAll(async () => {
  if (sql) await sql.end();
});

describeIfDb('upsertPlayers IP + GeoIP wiring', () => {
  it('records an IP observation with resolved geo and sets players.last_known_ip', async () => {
    const geoLookup: GeoLookup = { lookup: () => BERLIN_GEO };
    const eosId = `eos-ip-${randomBytes(8).toString('hex')}`;
    await upsertPlayers(db, [makePlayer({ eos_id: eosId, ip: '198.51.100.7' })], geoLookup);

    const playerId = await playerIdByEos(eosId);
    const [ipRow] = await db
      .select()
      .from(playerIpHistory)
      .where(eq(playerIpHistory.playerId, playerId));
    expect(String(ipRow?.ip)).toBe('198.51.100.7');
    expect(ipRow?.countryCode).toBe('DE');
    expect(ipRow?.city).toBe('Berlin');
    expect(ipRow?.observationCount).toBe(1);

    const [player] = await db
      .select({ ip: players.lastKnownIp })
      .from(players)
      .where(eq(players.id, playerId));
    expect(String(player?.ip)).toBe('198.51.100.7');
  });

  it('saves the IP with null geo when no GeoIP lookup is configured', async () => {
    const eosId = `eos-ip-${randomBytes(8).toString('hex')}`;
    await upsertPlayers(db, [makePlayer({ eos_id: eosId, ip: '198.51.100.8' })]);

    const playerId = await playerIdByEos(eosId);
    const [ipRow] = await db
      .select()
      .from(playerIpHistory)
      .where(eq(playerIpHistory.playerId, playerId));
    expect(String(ipRow?.ip)).toBe('198.51.100.8');
    expect(ipRow?.countryCode).toBeNull();
    expect(ipRow?.city).toBeNull();
  });

  it('does not touch IP history when the player carries no IP', async () => {
    const eosId = `eos-ip-${randomBytes(8).toString('hex')}`;
    await upsertPlayers(db, [makePlayer({ eos_id: eosId })]);

    const playerId = await playerIdByEos(eosId);
    const rows = await db
      .select()
      .from(playerIpHistory)
      .where(eq(playerIpHistory.playerId, playerId));
    expect(rows).toHaveLength(0);
  });
});
