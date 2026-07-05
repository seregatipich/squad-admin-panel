import { describe, expect, it } from 'vitest';
import type { CombatRecordCommand, VehicleRecordCommand } from '../src/parser/combat.js';
import { LogIngestor } from '../src/parser/ingest.js';

const SERVER_ID = '00000000-0000-7000-8000-000000000abc';
const ALICE_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const ALICE_STEAM = '76561198000000001';
const BOB_EOS = '0002bbbb0002bbbb0002bbbb0002bbbb';

function harness() {
  const combat: CombatRecordCommand[] = [];
  const vehicle: VehicleRecordCommand[] = [];
  const ingestor = new LogIngestor({
    serverId: SERVER_ID,
    beaconPort: 15000,
    onCombat: (command) => combat.push(command),
    onVehicle: (command) => vehicle.push(command),
  });
  return { ingestor, combat, vehicle };
}

const POSSESS_VEHICLE = `[2026.07.05-12.19.00:000][390]LogSquad: OnPossess(): PC=AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) Pawn=BP_BRDM2_Woodland_C_2147481000`;
const UNPOSSESS = `[2026.07.05-12.19.20:000][392]LogSquad: OnUnPossess(): PC=AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM})`;
const TURRET_KILL = `[2026.07.05-12.20.00:000][400]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_BRDM2_Coax_C`;
const VEHICLE_KILL = `[2026.07.05-12.20.05:000][405]LogSquadTrace: [DedicatedServer]ASQVehicle::Die(): Vehicle:BP_MBT_T72B3_C_2147480000 KillingDamage=-2500.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_Projectile_HEAT_C`;
const VEHICLE_ENV_DAMAGE = `[2026.07.05-12.20.10:000][410]LogSquad: Vehicle:BP_Logi_Truck_C_2147480020 ActualDamage=80.000000 from nullptr caused by BP_FireDamage_C`;

describe('LogIngestor vehicle wiring', () => {
  it('fills attacker_vehicle on a player kill fired from a possessed vehicle turret', () => {
    const { ingestor, combat } = harness();
    ingestor.ingest(POSSESS_VEHICLE);
    ingestor.ingest(TURRET_KILL);
    expect(combat).toHaveLength(1);
    expect(combat[0].kind).toBe('combat_death');
    expect(combat[0].attackerVehicle).toBe('BP_BRDM2_Woodland');
  });

  it('clears attacker_vehicle once the attacker dismounts (unpossess)', () => {
    const { ingestor, combat } = harness();
    ingestor.ingest(POSSESS_VEHICLE);
    ingestor.ingest(UNPOSSESS);
    ingestor.ingest(TURRET_KILL);
    expect(combat[0].attackerVehicle).toBeNull();
  });

  it('emits a vehicle_destroyed command carrying the raw victim asset + attacker vehicle', () => {
    const { ingestor, vehicle } = harness();
    ingestor.ingest(POSSESS_VEHICLE);
    ingestor.ingest(VEHICLE_KILL);
    expect(vehicle).toHaveLength(1);
    expect(vehicle[0].kind).toBe('vehicle_destroyed');
    expect(vehicle[0].serverId).toBe(SERVER_ID);
    expect(vehicle[0].victimVehicle).toBe('BP_MBT_T72B3');
    expect(vehicle[0].attacker?.eosId).toBe(ALICE_EOS);
    expect(vehicle[0].attackerVehicle).toBe('BP_BRDM2_Woodland');
  });

  it('emits vehicle damage without an attacker (deployable/environment) and no attacker vehicle', () => {
    const { ingestor, vehicle, combat } = harness();
    ingestor.ingest(VEHICLE_ENV_DAMAGE);
    expect(combat).toHaveLength(0);
    expect(vehicle).toHaveLength(1);
    expect(vehicle[0].kind).toBe('vehicle_damage');
    expect(vehicle[0].attacker).toBeNull();
    expect(vehicle[0].attackerVehicle).toBeNull();
    expect(vehicle[0].victimVehicle).toBe('BP_Logi_Truck');
  });

  it('does not treat a possess line as a combat or vehicle event', () => {
    const { ingestor, combat, vehicle } = harness();
    ingestor.ingest(POSSESS_VEHICLE);
    expect(combat).toHaveLength(0);
    expect(vehicle).toHaveLength(0);
  });

  it('keeps per-player vehicle state independent across attackers', () => {
    const { ingestor, combat } = harness();
    ingestor.ingest(POSSESS_VEHICLE);
    const bobKill = `[2026.07.05-12.21.00:000][420]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimCarol KillingDamage=-100.000000 from AttackerBob (Online IDs: EOS: ${BOB_EOS}) caused by BP_AK74_C`;
    ingestor.ingest(bobKill);
    expect(combat[0].attackerVehicle).toBeNull();
  });
});
