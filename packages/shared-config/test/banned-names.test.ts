import { describe, expect, it } from 'vitest';
import {
  BANNED_NAME_ACTIONS,
  BANNED_NAME_MATCH_TYPES,
  BANNED_NAME_NICK_MAX,
  BANNED_NAME_PATTERN_MAX,
  type BannedNameRuleForMatch,
  findBannedNameRuleMatch,
  isBannedNameAction,
  isBannedNameMatchType,
  isSafeBannedNameRegex,
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

  it('rejects catastrophic-backtracking regex patterns (#52 finding 1155)', () => {
    for (const evil of ['(a+)+$', '(a|aa)+$']) {
      expect(validateBannedNamePattern(evil, 'regex'), evil).toEqual({
        ok: false,
        error: 'pattern_unsafe_regex',
      });
    }
  });

  it('accepts a non-regex pattern of allowed length', () => {
    expect(validateBannedNamePattern('BadName', 'exact')).toEqual({ ok: true });
  });
});

// Audit #115 — a regex with nested or alternating repetition backtracks
// exponentially on a crafted nickname and blocks the API event loop.
describe('isSafeBannedNameRegex', () => {
  it.each([
    '(a+)+$',
    '(a*)*b',
    '(\\w+\\s?)*$',
    '(a?){20}a{20}',
    '(a|aa)+$',
    '(?:x+y?)+z',
    '((ab)+c)*',
    '(.*a){12}',
    '(a)\\1',
    '(?<n>a)\\k<n>',
    '(a{2,}){2}',
    '(a){2,}b|c)',
    'a)',
  ])('refuses %s', (pattern) => {
    expect(isSafeBannedNameRegex(pattern)).toBe(false);
  });

  it.each([
    '^\\[TAG\\].*',
    'admin\\d+',
    '(foo|bar)',
    '^(bad){2}$',
    '[a-z]+[0-9]*',
    '(\\(x+\\))',
    '[(+*)]+',
    '\\(a+\\)+',
    'a{3}',
    'a{2,}',
    'a{2,5}',
    'a{x',
    'a+?',
    '[^a-z]+',
    '[\\]x]+',
    'ab\\',
  ])('accepts %s', (pattern) => {
    expect(isSafeBannedNameRegex(pattern)).toBe(true);
  });

  it('makes validateBannedNamePattern refuse an unsafe regex', () => {
    expect(validateBannedNamePattern('(a+)+$', 'regex')).toEqual({
      ok: false,
      error: 'pattern_unsafe_regex',
    });
    expect(validateBannedNamePattern('(a+)+$', 'substring')).toEqual({ ok: true });
  });

  it('never runs a stored unsafe regex, so a crafted nickname cannot stall matching', () => {
    const started = Date.now();
    expect(matchBannedName('(a+)+$', 'regex', `${'a'.repeat(24)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('caps a checked nickname well above the Steam 32-character name limit', () => {
    expect(BANNED_NAME_NICK_MAX).toBe(64);
  });
});

describe('matchBannedName', () => {
  it('treats a regex that does not compile as no match', () => {
    expect(matchBannedName('[unclosed', 'regex', 'anything')).toBe(false);
  });

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

  it('matches regex case-insensitively (parity with the log-ingest worker matcher)', () => {
    expect(matchBannedName('BadWord', 'regex', 'thisisabadwordhere')).toBe(true);
    expect(matchBannedName('^admin', 'regex', 'ADMIN_Bob')).toBe(true);
  });

  it('never evaluates a catastrophic-backtracking regex (#52 finding 1155)', () => {
    // A rule stored before validation tightened must not run: it would match
    // here, and on a longer non-matching nick it would block the event loop.
    expect(matchBannedName('(a+)+$', 'regex', 'aaa')).toBe(false);
  });

  it('returns false for an invalid regex instead of throwing', () => {
    expect(matchBannedName('(unterminated', 'regex', 'anything')).toBe(false);
  });
});

describe('findBannedNameRuleMatch', () => {
  function rule(
    overrides: Partial<BannedNameRuleForMatch> & { id: string },
  ): BannedNameRuleForMatch {
    return {
      pattern: 'x',
      match_type: 'exact',
      action: 'kick',
      reason: null,
      ...overrides,
    };
  }

  it('returns null when no rule matches', () => {
    const rules = [rule({ id: '1', pattern: 'nope' })];
    expect(findBannedNameRuleMatch(rules, 'SomePlayer')).toBeNull();
  });

  it('prefers exact over substring over regex tiers', () => {
    const rules = [
      rule({ id: 'regex-rule', pattern: 'Bad', match_type: 'regex' }),
      rule({ id: 'substring-rule', pattern: 'Bad', match_type: 'substring' }),
      rule({ id: 'exact-rule', pattern: 'BadPlayer', match_type: 'exact' }),
    ];
    expect(findBannedNameRuleMatch(rules, 'BadPlayer')?.id).toBe('exact-rule');
  });

  it('falls back to substring when no exact rule matches, then regex', () => {
    const rules = [
      rule({ id: 'regex-rule', pattern: 'Bad\\d+', match_type: 'regex' }),
      rule({ id: 'substring-rule', pattern: 'Bad', match_type: 'substring' }),
    ];
    expect(findBannedNameRuleMatch(rules, 'xBadx')?.id).toBe('substring-rule');
    expect(findBannedNameRuleMatch(rules.slice(0, 1), 'Bad42')?.id).toBe('regex-rule');
  });

  it('within a tier, the first rule in input order wins (created_at, id order from the caller)', () => {
    const rules = [
      rule({ id: 'first', pattern: 'admin', match_type: 'substring' }),
      rule({ id: 'second', pattern: 'admin', match_type: 'substring' }),
    ];
    expect(findBannedNameRuleMatch(rules, 'the-admin-guy')?.id).toBe('first');
  });

  it('is case-insensitive across all three match types', () => {
    expect(
      findBannedNameRuleMatch(
        [rule({ id: '1', pattern: 'Cheater', match_type: 'exact' })],
        'cheater',
      )?.id,
    ).toBe('1');
    expect(
      findBannedNameRuleMatch(
        [rule({ id: '1', pattern: 'Hack', match_type: 'substring' })],
        'proHACKer',
      )?.id,
    ).toBe('1');
    expect(
      findBannedNameRuleMatch(
        [rule({ id: '1', pattern: '^admin', match_type: 'regex' })],
        'ADMIN_Bob',
      )?.id,
    ).toBe('1');
  });

  it('skips an invalid regex rule without throwing, falling through to the next rule', () => {
    const rules = [
      rule({ id: 'broken', pattern: '(unterminated', match_type: 'regex' }),
      rule({ id: 'fallback', pattern: 'anything', match_type: 'substring' }),
    ];
    expect(() => findBannedNameRuleMatch(rules, 'anything goes')).not.toThrow();
    expect(findBannedNameRuleMatch(rules, 'anything goes')?.id).toBe('fallback');
  });

  it('skips rules with an invalid match type', () => {
    const rules = [
      rule({ id: 'invalid', pattern: 'anything', match_type: 'invalid' as never }),
      rule({ id: 'fallback', pattern: 'anything', match_type: 'substring' }),
    ];
    expect(findBannedNameRuleMatch(rules, 'anything goes')?.id).toBe('fallback');
  });
});
