import { describe, expect, it } from 'vitest';
import {
  identityKey,
  type ParsedVehicleEvent,
  parseCombat,
  parseCombatVehicle,
  parsePossess,
  parseVehicleDamage,
  parseVehicleDestroy,
} from '../src/parser/combat.js';
import { parseLine } from '../src/parser/patterns.js';

const ALICE_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const ALICE_STEAM = '76561198000000001';

function line(raw: string): ReturnType<typeof parseLine> {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`fixture did not parse: ${raw}`);
  return parsed;
}

const VEHICLE_DESTROY_LINE = `[2026.07.05-12.20.00:000][400]LogSquadTrace: [DedicatedServer]ASQVehicle::Die(): Vehicle:BP_MBT_T72B3_C_2147480000 KillingDamage=-2500.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_Projectile_HEAT_C`;
const VEHICLE_DAMAGE_LINE = `[2026.07.05-12.20.01:000][401]LogSquad: Vehicle:BP_IFV_BMP2_C_2147480010 ActualDamage=250.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) caused by BP_Projectile_HEAT_C`;
const VEHICLE_ENV_DAMAGE_LINE = `[2026.07.05-12.20.02:000][402]LogSquad: Vehicle:BP_Logi_Truck_C_2147480020 ActualDamage=80.000000 from nullptr caused by BP_FireDamage_C`;
const POSSESS_VEHICLE_LINE = `[2026.07.05-12.19.00:000][390]LogSquad: OnPossess(): PC=AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) Pawn=BP_BRDM2_Woodland_C_2147481000`;
const POSSESS_SOLDIER_LINE = `[2026.07.05-12.19.10:000][391]LogSquad: OnPossess(): PC=AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM}) Pawn=BP_Soldier_RU_Rifleman_C_2147481002`;
const UNPOSSESS_LINE = `[2026.07.05-12.19.20:000][392]LogSquad: OnUnPossess(): PC=AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM})`;

describe('parseVehicleDestroy / parseVehicleDamage', () => {
  it('parses a vehicle-destroy line into the raw asset id + attacker + weapon', () => {
    const parsed = parseVehicleDestroy(line(VEHICLE_DESTROY_LINE)) as ParsedVehicleEvent;
    expect(parsed.kind).toBe('vehicle_destroyed');
    expect(parsed.victimVehicle).toBe('BP_MBT_T72B3');
    expect(parsed.attacker?.eosId).toBe(ALICE_EOS);
    expect(parsed.attacker?.steamId64).toBe(ALICE_STEAM);
    expect(parsed.weapon).toBe('BP_Projectile_HEAT');
    expect(parsed.damage).toBeCloseTo(2500);
    expect(parsed.attackerVehicle).toBeNull();
  });

  it('parses a vehicle-damage line', () => {
    const parsed = parseVehicleDamage(line(VEHICLE_DAMAGE_LINE)) as ParsedVehicleEvent;
    expect(parsed.kind).toBe('vehicle_damage');
    expect(parsed.victimVehicle).toBe('BP_IFV_BMP2');
    expect(parsed.attacker?.eosId).toBe(ALICE_EOS);
    expect(parsed.damage).toBeCloseTo(250);
  });

  it('treats vehicle damage without an attacker (from nullptr) as no attacker', () => {
    const parsed = parseVehicleDamage(line(VEHICLE_ENV_DAMAGE_LINE)) as ParsedVehicleEvent;
    expect(parsed.attacker).toBeNull();
    expect(parsed.victimVehicle).toBe('BP_Logi_Truck');
    expect(parsed.weapon).toBe('BP_FireDamage');
    expect(parsed.damage).toBeCloseTo(80);
  });

  it('dispatches vehicle lines through parseCombatVehicle by category', () => {
    expect(parseCombatVehicle(line(VEHICLE_DESTROY_LINE))?.kind).toBe('vehicle_destroyed');
    expect(parseCombatVehicle(line(VEHICLE_DAMAGE_LINE))?.kind).toBe('vehicle_damage');
  });

  it('does not confuse a vehicle victim with a player-combat event', () => {
    expect(parseCombat(line(VEHICLE_DESTROY_LINE))).toBeNull();
    expect(parseCombat(line(VEHICLE_DAMAGE_LINE))).toBeNull();
  });
});

describe('parsePossess', () => {
  it('records the vehicle asset when a player possesses a vehicle pawn', () => {
    const parsed = parsePossess(line(POSSESS_VEHICLE_LINE));
    expect(parsed?.vehicle).toBe('BP_BRDM2_Woodland');
    expect(parsed?.identity.eosId).toBe(ALICE_EOS);
  });

  it('reports a null vehicle when a player possesses a soldier pawn (dismount)', () => {
    const parsed = parsePossess(line(POSSESS_SOLDIER_LINE));
    expect(parsed?.vehicle).toBeNull();
  });

  it('reports a null vehicle on unpossess', () => {
    const parsed = parsePossess(line(UNPOSSESS_LINE));
    expect(parsed?.vehicle).toBeNull();
    expect(parsed?.identity.eosId).toBe(ALICE_EOS);
  });

  it('returns null for non-possess lines', () => {
    expect(parsePossess(line(VEHICLE_DAMAGE_LINE))).toBeNull();
  });
});

describe('identityKey', () => {
  it('prefers eos, then steam, then normalized name', () => {
    expect(identityKey({ eosId: ALICE_EOS, steamId64: ALICE_STEAM, name: 'Alice' })).toBe(
      `eos:${ALICE_EOS}`,
    );
    expect(identityKey({ eosId: null, steamId64: ALICE_STEAM, name: 'Alice' })).toBe(
      `steam:${ALICE_STEAM}`,
    );
    expect(identityKey({ eosId: null, steamId64: null, name: 'Alice Bravo' })).toBe(
      'name:alice bravo',
    );
  });
});
