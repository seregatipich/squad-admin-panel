import { describe, expect, it } from 'vitest';
import {
  buildTeamIndex,
  detectTeamkill,
  type ParsedCombat,
  parseCombat,
  parseCombatDamage,
  parseCombatDeath,
  parseCombatRevive,
  parseCombatWound,
  resolveTeam,
} from '../src/parser/combat.js';
import { parseLine } from '../src/parser/patterns.js';

const ALICE_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const BOB_EOS = '0002bbbb0002bbbb0002bbbb0002bbbb';
const CAROL_EOS = '0002cccc0002cccc0002cccc0002cccc';
const DAVE_EOS = '0002dddd0002dddd0002dddd0002dddd';
const ALICE_STEAM = '76561198000000001';
const CAROL_STEAM = '76561198000000003';
const DAVE_STEAM = '76561198000000004';

function line(raw: string): ReturnType<typeof parseLine> {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`fixture did not parse: ${raw}`);
  return parsed;
}

const DAMAGE_LINE = `[2026.07.05-12.00.00:000][100]LogSquad: Player:VictimBob ActualDamage=54.321000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM} | Controller ID: BP_PlayerController_C_2147481000) caused by BP_Projectile_762x54_C`;
const WOUND_LINE = `[2026.07.05-12.00.01:000][101]LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:VictimBob KillingDamage=-42.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM} | Controller ID: BP_PlayerController_C_2147481000) caused by BP_AK74_C`;
const DEATH_LINE = `[2026.07.05-12.00.02:000][102]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from AttackerAlice (Online IDs: EOS: ${ALICE_EOS} steam: ${ALICE_STEAM} | Controller ID: BP_PlayerController_C_2147481000) caused by BP_AK74_C`;
const REVIVE_LINE = `[2026.07.05-12.00.03:000][103]LogSquad: MedicCarol (Online IDs: EOS: ${CAROL_EOS} steam: ${CAROL_STEAM}) has revived RevivedDave (Online IDs: EOS: ${DAVE_EOS} steam: ${DAVE_STEAM}).`;

describe('parseCombat damage/wound/death', () => {
  it('parses a damage line into attacker + victim + weapon + amount', () => {
    const parsed = parseCombatDamage(line(DAMAGE_LINE)) as ParsedCombat;
    expect(parsed.kind).toBe('combat_damage');
    expect(parsed.victim.name).toBe('VictimBob');
    expect(parsed.attacker?.name).toBe('AttackerAlice');
    expect(parsed.attacker?.eosId).toBe(ALICE_EOS);
    expect(parsed.attacker?.steamId64).toBe(ALICE_STEAM);
    expect(parsed.weapon).toBe('BP_Projectile_762x54');
    expect(parsed.damage).toBeCloseTo(54.321);
    expect(parsed.isSuicide).toBe(false);
  });

  it('parses a wound line with negative KillingDamage', () => {
    const parsed = parseCombatWound(line(WOUND_LINE)) as ParsedCombat;
    expect(parsed.kind).toBe('combat_wound');
    expect(parsed.victim.name).toBe('VictimBob');
    expect(parsed.attacker?.eosId).toBe(ALICE_EOS);
    expect(parsed.weapon).toBe('BP_AK74');
    expect(parsed.damage).toBeCloseTo(42);
  });

  it('parses a death line', () => {
    const parsed = parseCombatDeath(line(DEATH_LINE)) as ParsedCombat;
    expect(parsed.kind).toBe('combat_death');
    expect(parsed.victim.name).toBe('VictimBob');
    expect(parsed.attacker?.name).toBe('AttackerAlice');
    expect(parsed.weapon).toBe('BP_AK74');
    expect(parsed.damage).toBeCloseTo(100);
  });

  it('dispatches by category through parseCombat', () => {
    expect(parseCombat(line(DAMAGE_LINE))?.kind).toBe('combat_damage');
    expect(parseCombat(line(WOUND_LINE))?.kind).toBe('combat_wound');
    expect(parseCombat(line(DEATH_LINE))?.kind).toBe('combat_death');
    expect(parseCombat(line(REVIVE_LINE))?.kind).toBe('combat_revive');
  });

  it('resolves an EOS-only attacker (no steam id in the line)', () => {
    const raw = `[2026.07.05-12.05.00:000][200]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from EosOnly (Online IDs: EOS: ${BOB_EOS}) caused by BP_M4_C`;
    const parsed = parseCombatDeath(line(raw)) as ParsedCombat;
    expect(parsed.attacker?.eosId).toBe(BOB_EOS);
    expect(parsed.attacker?.steamId64).toBeNull();
  });
});

describe('parseCombat revive', () => {
  it('parses medic and revived with both identities', () => {
    const parsed = parseCombatRevive(line(REVIVE_LINE)) as ParsedCombat;
    expect(parsed.kind).toBe('combat_revive');
    expect(parsed.attacker?.name).toBe('MedicCarol');
    expect(parsed.attacker?.eosId).toBe(CAROL_EOS);
    expect(parsed.victim.name).toBe('RevivedDave');
    expect(parsed.victim.eosId).toBe(DAVE_EOS);
    expect(parsed.victim.steamId64).toBe(DAVE_STEAM);
    expect(parsed.weapon).toBeNull();
    expect(parsed.damage).toBeNull();
  });
});

describe('parseCombat edge cases', () => {
  it('flags a suicide when attacker equals victim', () => {
    const raw = `[2026.07.05-12.10.00:000][300]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:LoneWolf KillingDamage=-100.000000 from LoneWolf (Online IDs: EOS: ${BOB_EOS} steam: 76561198000000009) caused by BP_Grenade_C`;
    const parsed = parseCombatDeath(line(raw)) as ParsedCombat;
    expect(parsed.isSuicide).toBe(true);
    expect(parsed.attacker?.name).toBe('LoneWolf');
  });

  it('treats environmental damage (from nullptr) as no attacker', () => {
    const raw = `[2026.07.05-12.11.00:000][301]LogSquad: Player:VictimBob ActualDamage=15.000000 from nullptr caused by BP_FallDamage_C`;
    const parsed = parseCombatDamage(line(raw)) as ParsedCombat;
    expect(parsed.attacker).toBeNull();
    expect(parsed.isSuicide).toBe(false);
    expect(parsed.weapon).toBe('BP_FallDamage');
    expect(parsed.damage).toBeCloseTo(15);
  });

  it('does not crash on a bot actor without online ids', () => {
    const raw = `[2026.07.05-12.12.00:000][302]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-80.000000 from BP_Soldier_INS caused by BP_RPG7_C`;
    const parsed = parseCombatDeath(line(raw)) as ParsedCombat;
    expect(parsed.attacker?.name).toBe('BP_Soldier_INS');
    expect(parsed.attacker?.eosId).toBeNull();
    expect(parsed.attacker?.steamId64).toBeNull();
  });

  it('ignores deployable-damage trace lines', () => {
    const raw = `[2026.07.05-12.13.00:000][303]LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_FOBRadio_C_2 TakeDamage=250.000000 from AttackerAlice caused by BP_C4_C`;
    expect(parseCombat(line(raw))).toBeNull();
  });

  it('returns null for unrelated categories', () => {
    const raw = `[2026.07.05-12.14.00:000][304]LogNet: Join succeeded: SomePlayer`;
    expect(parseCombat(line(raw))).toBeNull();
  });
});

describe('teamkill detection', () => {
  const roster = [
    { eos_id: ALICE_EOS, steam_id64: ALICE_STEAM, name: 'AttackerAlice', team_id: 1 },
    { eos_id: BOB_EOS, steam_id64: null, name: 'VictimBob', team_id: 1 },
    { eos_id: CAROL_EOS, steam_id64: CAROL_STEAM, name: 'MedicCarol', team_id: 2 },
  ];

  it('flags a same-team kill as a teamkill', () => {
    const index = buildTeamIndex(roster);
    const parsed = parseCombatDeath(line(DEATH_LINE)) as ParsedCombat;
    expect(detectTeamkill(parsed, index)).toBe(true);
  });

  it('does not flag an enemy kill', () => {
    const index = buildTeamIndex([
      { eos_id: ALICE_EOS, steam_id64: ALICE_STEAM, name: 'AttackerAlice', team_id: 1 },
      { eos_id: BOB_EOS, steam_id64: null, name: 'VictimBob', team_id: 2 },
    ]);
    const parsed = parseCombatDeath(line(DEATH_LINE)) as ParsedCombat;
    expect(detectTeamkill(parsed, index)).toBe(false);
  });

  it('does not flag a suicide as a teamkill', () => {
    const raw = `[2026.07.05-12.10.00:000][300]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:VictimBob KillingDamage=-100.000000 from VictimBob (Online IDs: EOS: ${BOB_EOS}) caused by BP_Grenade_C`;
    const index = buildTeamIndex(roster);
    const parsed = parseCombatDeath(line(raw)) as ParsedCombat;
    expect(detectTeamkill(parsed, index)).toBe(false);
  });

  it('does not flag when roster is missing a party', () => {
    const index = buildTeamIndex([
      { eos_id: ALICE_EOS, steam_id64: ALICE_STEAM, name: 'AttackerAlice', team_id: 1 },
    ]);
    const parsed = parseCombatDeath(line(DEATH_LINE)) as ParsedCombat;
    expect(detectTeamkill(parsed, index)).toBe(false);
  });

  it('resolves team by name when ids are absent', () => {
    const index = buildTeamIndex(roster);
    expect(resolveTeam({ eosId: null, steamId64: null, name: 'VictimBob' }, index)).toBe(1);
  });
});
