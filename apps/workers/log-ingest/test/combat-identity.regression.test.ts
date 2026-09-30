// regression (#62): combat identity resolution.
//  - #914: a victim is logged by name only; a name several players share (now or in their name
//    history) must not be pinned on an arbitrary one of them. The live roster disambiguates it.
//  - #915: when the attacker's EOS id and SteamID belong to two different `players` rows, the
//    identity backfill must not throw on the unique index and drop the combat event.
import {
  combatEvents,
  createDatabaseClient,
  events,
  playerNameHistory,
  players,
  servers,
} from '@squad/db';
import { eq, inArray, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCombat } from '../src/combat/store.js';
import { type CombatRecordCommand, parseCombat } from '../src/parser/combat.js';
import { parseLine } from '../src/parser/patterns.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the combat identity test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const TWIN_ONE_ID = uuidv7();
const TWIN_TWO_ID = uuidv7();
const RENAMER_ONE_ID = uuidv7();
const RENAMER_TWO_ID = uuidv7();
const EOS_ROW_ID = uuidv7();
const STEAM_ROW_ID = uuidv7();

const TWIN_ONE_EOS = '0062aaaa0062aaaa0062aaaa0062aaaa';
const TWIN_TWO_EOS = '0062bbbb0062bbbb0062bbbb0062bbbb';
const RENAMER_ONE_EOS = '0062cccc0062cccc0062cccc0062cccc';
const RENAMER_TWO_EOS = '0062dddd0062dddd0062dddd0062dddd';
const SPLIT_EOS = '0062eeee0062eeee0062eeee0062eeee';
const SPLIT_STEAM = '76561198062000005';
const SHOOTER_EOS = '0062ffff0062ffff0062ffff0062ffff';
const SHOOTER_STEAM = '76561198062000006';

const PLAYER_IDS = [
  TWIN_ONE_ID,
  TWIN_TWO_ID,
  RENAMER_ONE_ID,
  RENAMER_TWO_ID,
  EOS_ROW_ID,
  STEAM_ROW_ID,
];

function command(raw: string): CombatRecordCommand {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`fixture did not parse: ${raw}`);
  const combat = parseCombat(parsed);
  if (!combat) throw new Error(`fixture did not match a combat rule: ${raw}`);
  return { ...combat, serverId: SERVER_ID };
}

function damageLine(victim: string, tick: number): string {
  return `[2026.07.06-12.00.00:000][${tick}]LogSquad: Player:${victim} ActualDamage=20.000000 from ShooterSam (Online IDs: EOS: ${SHOOTER_EOS} steam: ${SHOOTER_STEAM} | Controller ID: BP_PlayerController_C_2147481001) caused by BP_AK74_C`;
}

function makeRedis(rosterPlayers?: unknown[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === `rcon:roster:${SERVER_ID}` && rosterPlayers) {
        return JSON.stringify({ server_id: SERVER_ID, players: rosterPlayers });
      }
      return null;
    }),
    publish: vi.fn().mockResolvedValue(1),
  };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Combat Identity Test Server',
    slug: `combat-identity-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: TWIN_ONE_ID,
      eosId: TWIN_ONE_EOS,
      canonicalName: 'TwinName',
      canonicalNameNormalized: 'twinname',
    },
    {
      id: TWIN_TWO_ID,
      eosId: TWIN_TWO_EOS,
      canonicalName: 'TwinName',
      canonicalNameNormalized: 'twinname',
    },
    {
      id: RENAMER_ONE_ID,
      eosId: RENAMER_ONE_EOS,
      canonicalName: 'RenamerOneNow',
      canonicalNameNormalized: 'renameronenow',
    },
    {
      id: RENAMER_TWO_ID,
      eosId: RENAMER_TWO_EOS,
      canonicalName: 'RenamerTwoNow',
      canonicalNameNormalized: 'renamertwonow',
    },
    {
      id: EOS_ROW_ID,
      eosId: SPLIT_EOS,
      steamId64: null,
      canonicalName: 'SplitEos',
      canonicalNameNormalized: 'spliteos',
    },
    {
      id: STEAM_ROW_ID,
      eosId: null,
      steamId64: BigInt(SPLIT_STEAM),
      canonicalName: 'SplitSteam',
      canonicalNameNormalized: 'splitsteam',
    },
  ]);
  await db.insert(playerNameHistory).values([
    { playerId: RENAMER_ONE_ID, name: 'FormerName', nameNormalized: 'formername' },
    { playerId: RENAMER_TWO_ID, name: 'FormerName', nameNormalized: 'formername' },
  ]);
});

beforeEach(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
});

afterAll(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(players).where(inArray(players.id, PLAYER_IDS));
  await db
    .delete(players)
    .where(or(eq(players.eosId, SHOOTER_EOS), eq(players.steamId64, BigInt(SHOOTER_STEAM))));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('victim resolution by name (#914)', () => {
  it('records no victim when two players currently share the name and the roster cannot tell them apart', async () => {
    const result = await handleCombat(db, makeRedis(), command(damageLine('TwinName', 1)));

    expect(result.inserted).toBe(true);
    expect(result.victimPlayerId).toBeNull();
  });

  it('takes the victim from the live roster when it names exactly one player with that name', async () => {
    const roster = [{ eos_id: TWIN_TWO_EOS, steam_id64: null, name: 'TwinName', team_id: 1 }];

    const result = await handleCombat(db, makeRedis(roster), command(damageLine('TwinName', 2)));

    expect(result.victimPlayerId).toBe(TWIN_TWO_ID);
  });

  it('records no victim when two roster members carry the same name', async () => {
    const roster = [
      { eos_id: TWIN_ONE_EOS, steam_id64: null, name: 'TwinName', team_id: 1 },
      { eos_id: TWIN_TWO_EOS, steam_id64: null, name: 'TwinName', team_id: 2 },
    ];

    const result = await handleCombat(db, makeRedis(roster), command(damageLine('TwinName', 3)));

    expect(result.victimPlayerId).toBeNull();
  });

  it('records no victim when the name only appears in the history of two different players', async () => {
    const result = await handleCombat(db, makeRedis(), command(damageLine('FormerName', 4)));

    expect(result.victimPlayerId).toBeNull();
  });

  it('still resolves an unambiguous name without a roster', async () => {
    const result = await handleCombat(db, makeRedis(), command(damageLine('RenamerOneNow', 5)));

    expect(result.victimPlayerId).toBe(RENAMER_ONE_ID);
  });
});

describe('attacker identity backfill (#915)', () => {
  it('records the event when the EOS id and SteamID belong to two different player rows', async () => {
    const line = `[2026.07.06-12.01.00:000][10]LogSquad: Player:RenamerTwoNow ActualDamage=20.000000 from SplitPerson (Online IDs: EOS: ${SPLIT_EOS} steam: ${SPLIT_STEAM} | Controller ID: BP_PlayerController_C_2147481002) caused by BP_AK74_C`;

    const first = await handleCombat(db, makeRedis(), command(line));
    const second = await handleCombat(
      db,
      makeRedis(),
      command(line.replace('[10]', '[11]').replace('12.01.00', '12.01.01')),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(first.attackerPlayerId).toBe(EOS_ROW_ID);
    expect(second.attackerPlayerId).toBe(EOS_ROW_ID);
    const rows = await db
      .select({ id: players.id, eosId: players.eosId, steamId64: players.steamId64 })
      .from(players)
      .where(inArray(players.id, [EOS_ROW_ID, STEAM_ROW_ID]));
    expect(rows.find((row) => row.id === EOS_ROW_ID)?.steamId64).toBeNull();
    expect(rows.find((row) => row.id === STEAM_ROW_ID)?.eosId).toBeNull();
  });
});
