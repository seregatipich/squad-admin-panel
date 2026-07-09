import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { playerKitTime, players, servers } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RconPlayer } from '../src/parse-list-players.js';
import { accruePlayerKitTime, upsertPlayers } from '../src/persist.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

function makePlayer(overrides: Partial<RconPlayer>): RconPlayer {
  return {
    rcon_id: 1,
    eos_id: `eos-kit-${randomBytes(8).toString('hex')}`,
    steam_id64: null,
    name: 'KitTester',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: 'USA_Medic_01',
    ...overrides,
  };
}

let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let serverId: string;

async function playerIdByEos(eosId: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.eosId, eosId));
  if (!row) throw new Error(`no player for eos_id=${eosId}`);
  return row.id;
}

async function kitTimeRows(playerId: string) {
  return db
    .select()
    .from(playerKitTime)
    .where(and(eq(playerKitTime.playerId, playerId), eq(playerKitTime.serverId, serverId)));
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  serverId = randomUUID();
  await db.insert(servers).values({
    id: serverId,
    displayName: 'Kit Time Test Server',
    slug: `kit-time-test-${randomBytes(4).toString('hex')}`,
  });
});

afterAll(async () => {
  if (sql) await sql.end();
});

describeIfDb('accruePlayerKitTime', () => {
  it('accrues ~30s to the held kit across two polls 30s apart', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    const roster = [makePlayer({ eos_id: eosId, role: 'USA_Medic_01' })];
    await upsertPlayers(db, roster);

    const poll1 = new Date('2026-01-01T00:00:00.000Z');
    await accruePlayerKitTime(db, roster, null, poll1, serverId);

    const poll2 = new Date(poll1.getTime() + 30_000);
    await accruePlayerKitTime(db, roster, poll1, poll2, serverId);

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kit).toBe('Medic');
    expect(rows[0]?.seconds).toBeGreaterThanOrEqual(29);
    expect(rows[0]?.seconds).toBeLessThanOrEqual(31);
    expect(rows[0]?.lastPlayedAt?.toISOString()).toBe(poll2.toISOString());
  });

  it('does not accrue anything on the first poll after (re)connect (prevPollAt = null)', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    const roster = [makePlayer({ eos_id: eosId, role: 'RGF_SL_01' })];
    await upsertPlayers(db, roster);
    await accruePlayerKitTime(db, roster, null, new Date(), serverId);

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    expect(rows).toHaveLength(0);
  });

  it('splits accrued time between kits across a mid-session role change', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    await upsertPlayers(db, [makePlayer({ eos_id: eosId, role: 'USA_Medic_01' })]);

    const poll1 = new Date('2026-01-02T00:00:00.000Z');
    await accruePlayerKitTime(
      db,
      [makePlayer({ eos_id: eosId, role: 'USA_Medic_01' })],
      null,
      poll1,
      serverId,
    );

    const poll2 = new Date(poll1.getTime() + 30_000);
    await accruePlayerKitTime(
      db,
      [makePlayer({ eos_id: eosId, role: 'USA_Medic_01' })],
      poll1,
      poll2,
      serverId,
    );

    const poll3 = new Date(poll2.getTime() + 30_000);
    await accruePlayerKitTime(
      db,
      [makePlayer({ eos_id: eosId, role: 'USA_Rifleman_01' })],
      poll2,
      poll3,
      serverId,
    );

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    const byKit = Object.fromEntries(rows.map((row) => [row.kit, row.seconds]));
    expect(byKit.Medic).toBe(30);
    expect(byKit.Rifleman).toBe(30);
  });

  it('accrues nothing for a null/unrecognized role', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    await upsertPlayers(db, [makePlayer({ eos_id: eosId, role: null })]);

    const poll1 = new Date('2026-01-03T00:00:00.000Z');
    await accruePlayerKitTime(
      db,
      [makePlayer({ eos_id: eosId, role: null })],
      null,
      poll1,
      serverId,
    );
    const poll2 = new Date(poll1.getTime() + 30_000);
    await accruePlayerKitTime(
      db,
      [makePlayer({ eos_id: eosId, role: null })],
      poll1,
      poll2,
      serverId,
    );

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    expect(rows).toHaveLength(0);
  });

  it('clamps an abnormally long gap between polls to the configured poll interval', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    const roster = [makePlayer({ eos_id: eosId, role: 'USA_HAT_01' })];
    await upsertPlayers(db, roster);

    const poll1 = new Date('2026-01-04T00:00:00.000Z');
    await accruePlayerKitTime(db, roster, null, poll1, serverId, 30_000);
    // A 10-minute gap far exceeds 2x the 30s poll interval and must not be
    // credited in full (that would count downtime as playtime).
    const poll2 = new Date(poll1.getTime() + 10 * 60_000);
    await accruePlayerKitTime(db, roster, poll1, poll2, serverId, 30_000);

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seconds).toBe(30);
  });

  it('accumulates seconds across repeated polls in the same kit', async () => {
    const eosId = `eos-kit-${randomBytes(8).toString('hex')}`;
    const roster = [makePlayer({ eos_id: eosId, role: 'MEA_LAT_01' })];
    await upsertPlayers(db, roster);

    let prev: Date | null = null;
    let now = new Date('2026-01-05T00:00:00.000Z');
    for (let i = 0; i < 4; i += 1) {
      await accruePlayerKitTime(db, roster, prev, now, serverId);
      prev = now;
      now = new Date(now.getTime() + 30_000);
    }

    const playerId = await playerIdByEos(eosId);
    const rows = await kitTimeRows(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kit).toBe('LAT');
    expect(rows[0]?.seconds).toBe(90);
  });
});
