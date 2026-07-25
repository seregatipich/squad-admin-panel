import {
  combatEvents,
  createDatabaseClient,
  events,
  players,
  playerVehicleKills,
  servers,
} from '@squad/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVehicle, LIVE_BUS_CHANNEL } from '../src/combat/store.js';
import { parseCombatVehicle, type VehicleRecordCommand } from '../src/parser/combat.js';
import { parseLine } from '../src/parser/patterns.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const ALICE_ID = uuidv7();
const ALICE_EOS = '0002fa11000000000000000000000001';
const ALICE_STEAM = '76561198000009901';

function command(raw: string, attackerVehicle: string | null = null): VehicleRecordCommand {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`fixture did not parse: ${raw}`);
  const vehicle = parseCombatVehicle(parsed);
  if (!vehicle) throw new Error(`fixture did not match a vehicle rule: ${raw}`);
  return { ...vehicle, attackerVehicle, serverId: SERVER_ID };
}

function makeRedis() {
  return {
    get: vi.fn(async () => null),
    publish: vi.fn().mockResolvedValue(1),
  };
}

const VEHICLE_KILL = `[2026.07.05-12.20.05:000][405]LogSquadTrace: [DedicatedServer]ASQVehicle::Die(): Vehicle:BP_MBT_ArbitraryUnknownAsset_C_2147480000 KillingDamage=-2500.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_Projectile_HEAT_C`;
const VEHICLE_ENV_DAMAGE = `[2026.07.05-12.20.10:000][410]LogSquad: Vehicle:BP_Logi_Truck_C_2147480020 ActualDamage=80.000000 from nullptr caused by BP_FireDamage_C`;

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Vehicle Test Server',
    slug: `vehicle-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values({
    id: ALICE_ID,
    eosId: ALICE_EOS,
    steamId64: BigInt(ALICE_STEAM),
    canonicalName: 'AttackerAlice',
    canonicalNameNormalized: 'attackeralice',
  });
});

afterAll(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, ALICE_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(combatEvents).where(eq(combatEvents.serverId, SERVER_ID));
  await db.delete(playerVehicleKills).where(eq(playerVehicleKills.playerId, ALICE_ID));
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
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

describe('handleVehicle', () => {
  it('writes a vehicle_destroyed event with the raw asset id and no victim player', async () => {
    const result = await handleVehicle(db, makeRedis(), command(VEHICLE_KILL, 'BP_BRDM2_Woodland'));
    expect(result.inserted).toBe(true);
    expect(result.attackerPlayerId).toBe(ALICE_ID);
    expect(result.victimVehicle).toBe('BP_MBT_ArbitraryUnknownAsset');

    const rows = await eventsOfKind('vehicle_destroyed');
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.attacker_player_id).toBe(ALICE_ID);
    expect(payload.victim_vehicle).toBe('BP_MBT_ArbitraryUnknownAsset');
    expect(payload.attacker_vehicle).toBe('BP_BRDM2_Woodland');
    expect(payload.weapon).toBe('BP_Projectile_HEAT');
    expect(rows[0].actorId).toBe(ALICE_ID);
  });

  it('writes an unknown asset id without a matching catalog row', async () => {
    const result = await handleVehicle(db, makeRedis(), command(VEHICLE_KILL));
    expect(result.inserted).toBe(true);
    const rows = await eventsOfKind('vehicle_destroyed');
    expect(rows).toHaveLength(1);
  });

  it('writes vehicle damage without an attacker', async () => {
    const result = await handleVehicle(db, makeRedis(), command(VEHICLE_ENV_DAMAGE));
    expect(result.attackerPlayerId).toBeNull();
    const rows = await eventsOfKind('vehicle_damage');
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).attacker_player_id).toBeNull();
  });

  it('publishes a combat.vehicle frame on the live-bus channel', async () => {
    const redis = makeRedis();
    await handleVehicle(db, redis, command(VEHICLE_KILL, 'BP_BRDM2_Woodland'));
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    const frame = JSON.parse(raw as string);
    expect(frame.type).toBe('combat.vehicle');
    expect(frame.data.victim_vehicle).toBe('BP_MBT_ArbitraryUnknownAsset');
  });

  it('does not duplicate on offset replay of the same line', async () => {
    const cmd = command(VEHICLE_KILL, 'BP_BRDM2_Woodland');
    const first = await handleVehicle(db, makeRedis(), cmd);
    const second = await handleVehicle(db, makeRedis(), cmd);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.eventId).toBe(first.eventId);
    const rows = await eventsOfKind('vehicle_destroyed');
    expect(rows).toHaveLength(1);
  });
});

describe('handleVehicle dossier aggregation (DOSSIER-2)', () => {
  async function vehicleKill(playerId: string, vehicle: string, weapon: string) {
    const rows = await db
      .select()
      .from(playerVehicleKills)
      .where(
        and(
          eq(playerVehicleKills.playerId, playerId),
          eq(playerVehicleKills.victimVehicleAssetId, vehicle),
          eq(playerVehicleKills.weapon, weapon),
        ),
      );
    return rows[0] ?? null;
  }

  it('writes a vehicle_destroyed combat_events row and the (vehicle, weapon) kill atomically', async () => {
    await handleVehicle(db, makeRedis(), command(VEHICLE_KILL, 'BP_BRDM2_Woodland'));

    const ce = await combatEventsOfType('vehicle_destroyed');
    expect(ce).toHaveLength(1);
    expect(ce[0].attackerPlayerId).toBe(ALICE_ID);
    expect(ce[0].victimPlayerId).toBeNull();
    expect(ce[0].victimVehicle).toBe('BP_MBT_ArbitraryUnknownAsset');
    expect(ce[0].weapon).toBe('BP_Projectile_HEAT');

    const vk = await vehicleKill(ALICE_ID, 'BP_MBT_ArbitraryUnknownAsset', 'BP_Projectile_HEAT');
    expect(vk?.destroyedCount).toBe(1);
  });

  it('does not double-count the vehicle kill on offset replay (idempotency)', async () => {
    const cmd = command(VEHICLE_KILL, 'BP_BRDM2_Woodland');
    await handleVehicle(db, makeRedis(), cmd);
    const second = await handleVehicle(db, makeRedis(), cmd);
    expect(second.inserted).toBe(false);

    const ce = await combatEventsOfType('vehicle_destroyed');
    expect(ce).toHaveLength(1);
    const vk = await vehicleKill(ALICE_ID, 'BP_MBT_ArbitraryUnknownAsset', 'BP_Projectile_HEAT');
    expect(vk?.destroyedCount).toBe(1);
  });
});
