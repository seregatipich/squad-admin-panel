import { describe, expect, it } from 'vitest';
import {
  BANNED_NAME_ACTIONS,
  BANNED_NAME_MATCH_TYPES,
  BANNED_NAME_PATTERN_MAX,
  isBannedNameAction,
  isBannedNameMatchType,
  matchBannedName,
  validateBannedNamePattern,
} from '../src/banned-names.js';

describe('banned-names constants + guards', () => {
  it('exposes the fixed match-type and action vocabularies', () => {
    expect(BANNED_NAME_MATCH_TYPES).toEqual(['exact', 'substring', 'regex']);
    expect(BANNED_NAME_ACTIONS).toEqual(['kick', 'alert']);
    expect(BANNED_NAME_PATTERN_MAX).toBe(256);
  });

  it('isBannedNameMatchType accepts known types and rejects others', () => {
    expect(isBannedNameMatchType('exact')).toBe(true);
    expect(isBannedNameMatchType('regex')).toBe(true);
    expect(isBannedNameMatchType('glob')).toBe(false);
  });

  it('isBannedNameAction accepts known actions and rejects others', () => {
    expect(isBannedNameAction('kick')).toBe(true);
    expect(isBannedNameAction('alert')).toBe(true);
    expect(isBannedNameAction('ban')).toBe(false);
  });
});

describe('validateBannedNamePattern', () => {
  it('rejects an empty pattern', () => {
    expect(validateBannedNamePattern('', 'exact')).toEqual({ ok: false, error: 'pattern_empty' });
  });

  it('rejects an over-long pattern', () => {
    const result = validateBannedNamePattern('a'.repeat(BANNED_NAME_PATTERN_MAX + 1), 'substring');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('pattern_too_long');
  });

  it('accepts a valid regex pattern', () => {
    expect(validateBannedNamePattern('^admin\\d+$', 'regex')).toEqual({ ok: true });
  });

  it('rejects an invalid regex with the compiler error message', () => {
    const result = validateBannedNamePattern('(unterminated', 'regex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('accepts a non-regex pattern of allowed length', () => {
    expect(validateBannedNamePattern('BadName', 'exact')).toEqual({ ok: true });
  });
});

describe('matchBannedName', () => {
  it('never matches an empty pattern', () => {
    expect(matchBannedName('', 'exact', 'anything')).toBe(false);
  });

  it('matches exact case-insensitively', () => {
    expect(matchBannedName('Cheater', 'exact', 'cheater')).toBe(true);
    expect(matchBannedName('Cheater', 'exact', 'cheaterX')).toBe(false);
  });

  it('matches substring case-insensitively', () => {
    expect(matchBannedName('hack', 'substring', 'proHACKer')).toBe(true);
    expect(matchBannedName('hack', 'substring', 'legit')).toBe(false);
  });

  it('matches a valid regex', () => {
    expect(matchBannedName('^\\[ADMIN\\]', 'regex', '[ADMIN]Bob')).toBe(true);
    expect(matchBannedName('^\\[ADMIN\\]', 'regex', 'Bob')).toBe(false);
  });

  it('returns false for an invalid regex instead of throwing', () => {
    expect(matchBannedName('(unterminated', 'regex', 'anything')).toBe(false);
  });
});
