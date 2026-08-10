import {
  combatEvents,
  createDatabaseClient,
  events,
  matches,
  players,
  playerVehicleStats,
  playerWeaponStats,
  servers,
} from '@squad/db';
import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCombat, LIVE_BUS_CHANNEL } from '../src/combat/store.js';
import { type CombatRecordCommand, parseCombat } from '../src/parser/combat.js';
import { parseLine } from '../src/parser/patterns.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the combat1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const ALICE_ID = uuidv7();
const BOB_ID = uuidv7();
const MEDIC_ID = uuidv7();
const REVIVED_ID = uuidv7();

const ALICE_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const BOB_EOS = '0002bbbb0002bbbb0002bbbb0002bbbb';
const CAROL_EOS = '0002cccc0002cccc0002cccc0002cccc';
const DAVE_EOS = '0002dddd0002dddd0002dddd0002dddd';
const NEWCOMER_EOS = '0002eeee0002eeee0002eeee0002eeee';
const ALICE_STEAM = '76561198000000001';
const CAROL_STEAM = '76561198000000003';
const DAVE_STEAM = '76561198000000004';

function command(raw: string): CombatRecordCommand {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`fixture did not parse: ${raw}`);
  const combat = parseCombat(parsed);
  if (!combat) throw new Error(`fixture did not match a combat rule: ${raw}`);
  return { ...combat, serverId: SERVER_ID };
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

const DEATH_LINE = `[2026.07.05-12.00.02:000][102]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM} | Controller ID: BP_PlayerController_C_2147481000) caused by BP_AK74_C`;
const DAMAGE_LINE = `[2026.07.05-12.00.00:000][100]LogSquad: Player:VictimBob ActualDamage=54.321000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM} | Controller ID: BP_PlayerController_C_2147481000) caused by BP_Projectile_762x54_C`;
const REVIVE_LINE = `[2026.07.05-12.00.03:000][103]LogSquad: MedicCarol (Online IDs: EOS: ${CAROL_EOS} steam: ${CAROL_STEAM}) has revived RevivedDave (Online IDs: EOS: ${DAVE_EOS} steam: ${DAVE_STEAM}).`;
const SUICIDE_LINE = `[2026.07.05-12.10.00:000][300]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:AttackerAlice KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_Grenade_C`;
const ENV_LINE = `[2026.07.05-12.11.00:000][301]LogSquad: Player:VictimBob ActualDamage=15.000000 from nullptr caused by BP_FallDamage_C`;
const EOS_ONLY_KILL = `[2026.07.05-12.05.00:000][200]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from Newcomer (Online IDs: EOS: ${NEWCOMER_EOS}) caused by BP_M4_C`;
const WOUND_LINE = `[2026.07.05-12.00.01:000][101]LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:VictimBob KillingDamage=-50.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_AK74_C`;

const AGGREGATE_PLAYER_IDS = [ALICE_ID, BOB_ID, MEDIC_ID, REVIVED_ID];

const ROSTER_SAME_TEAM = [
  { eos_id: ALICE_EOS, steam_id64: ALICE_STEAM, name: 'AttackerAlice', team_id: 1 },
  { eos_id: BOB_EOS, steam_id64: null, name: 'VictimBob', team_id: 1 },
];
const ROSTER_ENEMY = [
  { eos_id: ALICE_EOS, steam_id64: ALICE_STEAM, name: 'AttackerAlice', team_id: 1 },
  { eos_id: BOB_EOS, steam_id64: null, name: 'VictimBob', team_id: 2 },
];

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Combat Test Server',
    slug: `combat-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: ALICE_ID,
      eosId: ALICE_EOS,
      steamId64: BigInt(ALICE_STEAM),
      canonicalName: 'AttackerAlice',
      canonicalNameNormalized: 'attackeralice',
    },
    {
      id: BOB_ID,
      eosId: BOB_EOS,
      steamId64: null,
      canonicalName: 'VictimBob',
      canonicalNameNormalized: 'victimbob',
    },
    {
      id: MEDIC_ID,
      eosId: CAROL_EOS,
      steamId64: BigInt(CAROL_STEAM),
      canonicalName: 'MedicCarol',
      canonicalNameNormalized: 'mediccarol',
    },
    {
      id: REVIVED_ID,
      eosId: DAVE_EOS,
      steamId64: BigInt(DAVE_STEAM),
      canonicalName: 'RevivedDave',
      canonicalNameNormalized: 'reviveddave',
    },
  ]);
});

afterAll(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  // Aggregates cascade on player delete; the shared test:cov DB keeps these
  // scoped to this run's unique player uuids.
  await db.delete(players).where(eq(players.id, ALICE_ID));
  await db.delete(players).where(eq(players.id, BOB_ID));
  await db.delete(players).where(eq(players.id, MEDIC_ID));
  await db.delete(players).where(eq(players.id, REVIVED_ID));
  await db.delete(players).where(eq(players.eosId, NEWCOMER_EOS));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db
    .delete(playerWeaponStats)
    .where(inArray(playerWeaponStats.playerId, AGGREGATE_PLAYER_IDS));
  await db
    .delete(playerVehicleStats)
    .where(inArray(playerVehicleStats.playerId, AGGREGATE_PLAYER_IDS));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(matches).where(eq(matches.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.eosId, NEWCOMER_EOS));
});

async function eventsOfKind(kind: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, kind)));
}

async function combatEventsOfType(eventType: string) {
  return db
    .select()
    .from(combatEvents)
    .where(and(eq(combatEvents.serverId, SERVER_ID), eq(combatEvents.eventType, eventType)));
}

async function weaponStat(playerId: string, weapon: string) {
  const rows = await db
    .select()
    .from(playerWeaponStats)
    .where(and(eq(playerWeaponStats.playerId, playerId), eq(playerWeaponStats.weapon, weapon)));
  return rows[0] ?? null;
}

describe('handleCombat envelope writes', () => {
  it('writes a death event with resolved attacker/victim uuids, weapon and damage', async () => {
    const result = await handleCombat(db, makeRedis(), command(DEATH_LINE));
    expect(result.inserted).toBe(true);
    expect(result.attackerPlayerId).toBe(ALICE_ID);
    expect(result.victimPlayerId).toBe(BOB_ID);

    const rows = await eventsOfKind('combat_death');
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.attacker_player_id).toBe(ALICE_ID);
    expect(payload.victim_player_id).toBe(BOB_ID);
    expect(payload.weapon).toBe('BP_AK74');
    expect(payload.damage).toBeCloseTo(100);
    expect(payload.is_teamkill).toBe(false);
    expect(rows[0].actorId).toBe(ALICE_ID);
  });

  it('writes a damage event with the numeric damage amount', async () => {
    await handleCombat(db, makeRedis(), command(DAMAGE_LINE));
    const rows = await eventsOfKind('combat_damage');
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.damage).toBeCloseTo(54.321);
    expect(payload.weapon).toBe('BP_Projectile_762x54');
  });

  it('writes a revive event with resolved medic/revived uuids', async () => {
    const result = await handleCombat(db, makeRedis(), command(REVIVE_LINE));
    expect(result.attackerPlayerId).toBe(MEDIC_ID);
    expect(result.victimPlayerId).toBe(REVIVED_ID);
    const rows = await eventsOfKind('combat_revive');
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.medic_player_id).toBe(MEDIC_ID);
    expect(payload.revived_player_id).toBe(REVIVED_ID);
  });

  it('publishes a combat.event frame on the live-bus channel', async () => {
    const redis = makeRedis();
    await handleCombat(db, redis, command(DEATH_LINE));
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    const frame = JSON.parse(raw as string);
    expect(frame.type).toBe('combat.event');
    expect(frame.data.kind).toBe('combat_death');
    expect(frame.data.attacker_player_id).toBe(ALICE_ID);
  });
});

describe('handleCombat teamkill detection', () => {
  it('flags a same-team kill from the roster snapshot', async () => {
    const result = await handleCombat(db, makeRedis(ROSTER_SAME_TEAM), command(DEATH_LINE));
    expect(result.isTeamkill).toBe(true);
    const rows = await eventsOfKind('combat_death');
    expect((rows[0].payload as Record<string, unknown>).is_teamkill).toBe(true);
  });

  it('does not flag an enemy kill', async () => {
    const result = await handleCombat(db, makeRedis(ROSTER_ENEMY), command(DEATH_LINE));
    expect(result.isTeamkill).toBe(false);
  });

  it('does not flag when the roster cache is missing', async () => {
    const result = await handleCombat(db, makeRedis(), command(DEATH_LINE));
    expect(result.isTeamkill).toBe(false);
  });
});

describe('handleCombat player resolution edge cases', () => {
  it('creates an EOS-only attacker that is not yet known', async () => {
    const result = await handleCombat(db, makeRedis(), command(EOS_ONLY_KILL));
    expect(result.attackerPlayerId).not.toBeNull();
    const created = await db.select().from(players).where(eq(players.eosId, NEWCOMER_EOS));
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(result.attackerPlayerId);
    expect(created[0].steamId64).toBeNull();
  });

  it('records a suicide without a teamkill flag', async () => {
    const result = await handleCombat(db, makeRedis(ROSTER_SAME_TEAM), command(SUICIDE_LINE));
    expect(result.isTeamkill).toBe(false);
    const rows = await eventsOfKind('combat_death');
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.is_suicide).toBe(true);
    expect(payload.is_teamkill).toBe(false);
  });

  it('records environmental damage with a null attacker', async () => {
    const result = await handleCombat(db, makeRedis(), command(ENV_LINE));
    expect(result.attackerPlayerId).toBeNull();
    const rows = await eventsOfKind('combat_damage');
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).attacker_player_id).toBeNull();
  });
});

describe('handleCombat match association and dedup', () => {
  it('binds the event to the open match', async () => {
    const matchId = uuidv7();
    await db.insert(matches).values({
      id: matchId,
      serverId: SERVER_ID,
      startedAt: new Date('2026-07-05T11:00:00.000Z'),
      endedAt: null,
    });
    const result = await handleCombat(db, makeRedis(), command(DEATH_LINE));
    expect(result.matchId).toBe(matchId);
    const rows = await eventsOfKind('combat_death');
    expect(rows[0].correlationId).toBe(matchId);
    expect((rows[0].payload as Record<string, unknown>).match_id).toBe(matchId);
  });

  it('leaves match_id null when no match brackets the event', async () => {
    const result = await handleCombat(db, makeRedis(), command(DEATH_LINE));
    expect(result.matchId).toBeNull();
  });

  it('does not duplicate on offset replay of the same line', async () => {
    const cmd = command(DEATH_LINE);
    const first = await handleCombat(db, makeRedis(), cmd);
    const second = await handleCombat(db, makeRedis(), cmd);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    const rows = await eventsOfKind('combat_death');
    expect(rows).toHaveLength(1);
  });
});

describe('handleCombat dossier aggregation (DOSSIER-2)', () => {
  it('writes one combat_events death row and increments the weapon kill atomically', async () => {
    await handleCombat(db, makeRedis(), command(DEATH_LINE));

    const ce = await combatEventsOfType('death');
    expect(ce).toHaveLength(1);
    expect(ce[0].attackerPlayerId).toBe(ALICE_ID);
    expect(ce[0].victimPlayerId).toBe(BOB_ID);
    expect(ce[0].weapon).toBe('BP_AK74');
    expect(ce[0].isTeamkill).toBe(false);

    const ws = await weaponStat(ALICE_ID, 'BP_AK74');
    expect(ws?.kills).toBe(1);
    expect(ws?.teamkills).toBe(0);
    expect(ws?.shotsEvents).toBe(0);
    expect(ws?.damage).toBeNull();
    expect(ws?.lastUsedAt).not.toBeNull();
  });

  it('accumulates weapon shots and damage from a damage line', async () => {
    await handleCombat(db, makeRedis(), command(DAMAGE_LINE));

    const ce = await combatEventsOfType('damage');
    expect(ce).toHaveLength(1);

    const ws = await weaponStat(ALICE_ID, 'BP_Projectile_762x54');
    expect(ws?.shotsEvents).toBe(1);
    expect(ws?.kills).toBe(0);
    expect(Number(ws?.damage)).toBeCloseTo(54.321);
  });

  it('counts a same-team kill as a teamkill in the aggregate', async () => {
    await handleCombat(db, makeRedis(ROSTER_SAME_TEAM), command(DEATH_LINE));
    const ws = await weaponStat(ALICE_ID, 'BP_AK74');
    expect(ws?.kills).toBe(0);
    expect(ws?.teamkills).toBe(1);
  });

  it('increments player_vehicle_stats when the kill came from a vehicle', async () => {
    const cmd: CombatRecordCommand = { ...command(DEATH_LINE), attackerVehicle: 'BTR82A' };
    await handleCombat(db, makeRedis(), cmd);

    const rows = await db
      .select()
      .from(playerVehicleStats)
      .where(
        and(
          eq(playerVehicleStats.playerId, ALICE_ID),
          eq(playerVehicleStats.vehicleAssetId, 'BTR82A'),
        ),
      );
    expect(rows[0]?.kills).toBe(1);
  });

  it('records a wound line in combat_events without moving any weapon aggregate', async () => {
    await handleCombat(db, makeRedis(), command(WOUND_LINE));
    const ce = await combatEventsOfType('wound');
    expect(ce).toHaveLength(1);
    expect(await weaponStat(ALICE_ID, 'BP_AK74')).toBeNull();
  });

  it('does not double-count the aggregate on offset replay (idempotency)', async () => {
    const cmd = command(DEATH_LINE);
    await handleCombat(db, makeRedis(), cmd);
    const second = await handleCombat(db, makeRedis(), cmd);
    expect(second.inserted).toBe(false);

    const ce = await combatEventsOfType('death');
    expect(ce).toHaveLength(1);
    const ws = await weaponStat(ALICE_ID, 'BP_AK74');
    expect(ws?.kills).toBe(1);
  });

  it('aggregates an EOS-only attacker by uuid', async () => {
    const result = await handleCombat(db, makeRedis(), command(EOS_ONLY_KILL));
    expect(result.attackerPlayerId).not.toBeNull();
    const ws = await weaponStat(result.attackerPlayerId as string, 'BP_M4');
    expect(ws?.kills).toBe(1);
  });
});
