import { describe, expect, it } from 'vitest';
import {
  addCandidate,
  buildCandidatesPayload,
  buildSettingsPayload,
  isValidCooldown,
  isValidWeight,
  type MapVoteCandidate,
  type MapVoteSettingsForm,
  removeCandidateAt,
  validateCandidates,
  validateSettings,
} from './helpers';

function candidate(overrides: Partial<MapVoteCandidate> = {}): MapVoteCandidate {
  return {
    layer: 'Yehorivka RAAS v11',
    map: 'Yehorivka',
    gamemode: 'RAAS',
    weight: 1,
    enabled: true,
    deprecated: false,
    ...overrides,
  };
}

function settingsForm(overrides: Partial<MapVoteSettingsForm> = {}): MapVoteSettingsForm {
  return {
    enabled: false,
    selection: 'weighted_random',
    layerCooldown: 3,
    mapCooldown: 2,
    broadcastTemplate: '',
    ...overrides,
  };
}

describe('isValidWeight', () => {
  it('accepts integers 1..100 and rejects everything else', () => {
    expect(isValidWeight(1)).toBe(true);
    expect(isValidWeight(100)).toBe(true);
    expect(isValidWeight(0)).toBe(false);
    expect(isValidWeight(101)).toBe(false);
    expect(isValidWeight(2.5)).toBe(false);
    expect(isValidWeight(Number.NaN)).toBe(false);
  });
});

describe('isValidCooldown', () => {
  it('accepts integers 0..20 and rejects everything else', () => {
    expect(isValidCooldown(0)).toBe(true);
    expect(isValidCooldown(20)).toBe(true);
    expect(isValidCooldown(-1)).toBe(false);
    expect(isValidCooldown(21)).toBe(false);
    expect(isValidCooldown(1.5)).toBe(false);
  });
});

describe('validateCandidates', () => {
  it('returns null for a valid list', () => {
    expect(validateCandidates([candidate(), candidate({ layer: 'Gorodok RAAS v1' })])).toBeNull();
  });

  it('names the offending layer for an out-of-range weight', () => {
    const error = validateCandidates([candidate({ weight: 0 })]);
    expect(error).toContain('Yehorivka RAAS v11');
    expect(error).toContain('от 1 до 100');
  });
});

describe('validateSettings', () => {
  it('returns null for a valid disabled form without candidates', () => {
    expect(validateSettings(settingsForm(), 0)).toBeNull();
  });

  it('rejects enabling without candidates', () => {
    expect(validateSettings(settingsForm({ enabled: true }), 0)).toContain('без кандидатов');
    expect(validateSettings(settingsForm({ enabled: true }), 2)).toBeNull();
  });

  it('rejects out-of-range cooldowns and an over-long template', () => {
    expect(validateSettings(settingsForm({ layerCooldown: 21 }), 0)).toContain('от 0 до 20');
    expect(validateSettings(settingsForm({ mapCooldown: -1 }), 0)).toContain('от 0 до 20');
    expect(validateSettings(settingsForm({ broadcastTemplate: 'x'.repeat(301) }), 0)).toContain(
      '300',
    );
  });
});

describe('buildSettingsPayload', () => {
  it('maps camelCase state to the snake_case body and nulls an empty template', () => {
    expect(buildSettingsPayload(settingsForm({ enabled: true, broadcastTemplate: '  ' }))).toEqual({
      enabled: true,
      selection: 'weighted_random',
      layer_cooldown: 3,
      map_cooldown: 2,
      broadcast_template: null,
    });
    expect(
      buildSettingsPayload(settingsForm({ broadcastTemplate: 'Следующая карта: {layer}' }))
        .broadcast_template,
    ).toBe('Следующая карта: {layer}');
  });
});

describe('buildCandidatesPayload', () => {
  it('strips catalog metadata and includes confirm_deprecated only when set', () => {
    const rows = [candidate({ weight: 7, enabled: false })];
    expect(buildCandidatesPayload(rows, false)).toEqual({
      candidates: [{ layer: 'Yehorivka RAAS v11', weight: 7, enabled: false }],
    });
    expect(buildCandidatesPayload(rows, true)).toEqual({
      candidates: [{ layer: 'Yehorivka RAAS v11', weight: 7, enabled: false }],
      confirm_deprecated: true,
    });
  });
});

describe('addCandidate / removeCandidateAt', () => {
  it('appends a catalog layer with weight 1 and ignores duplicates', () => {
    const layer = { name: 'Gorodok RAAS v1', map: 'Gorodok', gamemode: 'RAAS', deprecated: false };
    const next = addCandidate([candidate()], layer);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ layer: 'Gorodok RAAS v1', weight: 1, enabled: true });
    expect(addCandidate(next, layer)).toHaveLength(2);
  });

  it('removes the row at the given index', () => {
    const rows = [candidate(), candidate({ layer: 'Gorodok RAAS v1' })];
    expect(removeCandidateAt(rows, 0)).toEqual([rows[1]]);
  });
});
