import { describe, expect, it } from 'vitest';
import { normalizeRoleName } from '../src/role-name.js';

describe('normalizeRoleName', () => {
  it('strips the USA faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('USA_Rifleman_01')).toBe('Rifleman');
    expect(normalizeRoleName('USA_SL_01')).toBe('SL');
    expect(normalizeRoleName('USA_Medic_02')).toBe('Medic');
    expect(normalizeRoleName('USA_AutoRifleman_01')).toBe('AutoRifleman');
    expect(normalizeRoleName('USA_HAT_01')).toBe('HAT');
  });

  it('strips the RGF faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('RGF_SL_01')).toBe('SL');
    expect(normalizeRoleName('RGF_Rifleman_03')).toBe('Rifleman');
    expect(normalizeRoleName('RGF_Crewman_01')).toBe('Crewman');
    expect(normalizeRoleName('RGF_LAT_01')).toBe('LAT');
  });

  it('strips the MEA faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('MEA_Grenadier_01')).toBe('Grenadier');
    expect(normalizeRoleName('MEA_Marksman_01')).toBe('Marksman');
    expect(normalizeRoleName('MEA_Machinegunner_01')).toBe('Machinegunner');
  });

  it('strips the INS faction prefix, including kits with no numeric suffix', () => {
    expect(normalizeRoleName('INS_Medic')).toBe('Medic');
    expect(normalizeRoleName('INS_Rifleman_01')).toBe('Rifleman');
    expect(normalizeRoleName('INS_Sapper_01')).toBe('Sapper');
  });

  it('strips the BAF faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('BAF_Rifleman_01')).toBe('Rifleman');
    expect(normalizeRoleName('BAF_SL_01')).toBe('SL');
    expect(normalizeRoleName('BAF_Pilot_01')).toBe('Pilot');
  });

  it('strips the CAF faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('CAF_Rifleman_01')).toBe('Rifleman');
    expect(normalizeRoleName('CAF_Medic_01')).toBe('Medic');
  });

  it('strips the USMC faction prefix and numeric suffix', () => {
    expect(normalizeRoleName('USMC_Rifleman_01')).toBe('Rifleman');
    expect(normalizeRoleName('USMC_HAT_01')).toBe('HAT');
    expect(normalizeRoleName('USMC_Pilot_01')).toBe('Pilot');
  });

  it('unifies the same kit across factions to the same normalized name', () => {
    expect(normalizeRoleName('USA_Medic_01')).toBe(normalizeRoleName('RGF_Medic_01'));
    expect(normalizeRoleName('MEA_SL_01')).toBe(normalizeRoleName('INS_SL_01'));
  });

  it('returns null for null, undefined, or empty input', () => {
    expect(normalizeRoleName(null)).toBeNull();
    expect(normalizeRoleName(undefined)).toBeNull();
    expect(normalizeRoleName('')).toBeNull();
    expect(normalizeRoleName('   ')).toBeNull();
  });

  it('returns null for an unrecognized faction prefix', () => {
    expect(normalizeRoleName('ZZZ_Rifleman_01')).toBeNull();
  });

  it('returns null for a malformed role-string with no kit segment', () => {
    expect(normalizeRoleName('USA')).toBeNull();
    expect(normalizeRoleName('USA_01')).toBeNull();
  });

  it('is case-sensitive on the faction prefix (lowercase is unrecognized)', () => {
    expect(normalizeRoleName('usa_Rifleman_01')).toBeNull();
  });
});
