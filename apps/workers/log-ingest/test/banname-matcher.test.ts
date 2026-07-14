import { describe, expect, it } from 'vitest';
import {
  type BannedNameRuleRow,
  compileBannedNameRules,
  matchBannedNickname,
} from '../src/banname/matcher.js';

function rule(overrides: Partial<BannedNameRuleRow> & { id: string }): BannedNameRuleRow {
  return {
    pattern: 'cheater',
    matchType: 'substring',
    reason: null,
    action: 'kick',
    ...overrides,
  };
}

describe('compileBannedNameRules + matchBannedNickname', () => {
  it('returns null when there are no rules', () => {
    expect(matchBannedNickname('AnyName', compileBannedNameRules([]))).toBeNull();
  });

  it('returns null when no rule matches', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'r1', pattern: 'hacker', matchType: 'substring' }),
    ]);
    expect(matchBannedNickname('LegitPlayer', compiled)).toBeNull();
  });

  it('matches an exact rule case-insensitively', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'r1', pattern: 'BadName', matchType: 'exact' }),
    ]);
    expect(matchBannedNickname('badname', compiled)).toMatchObject({
      ruleId: 'r1',
      matchType: 'exact',
    });
    expect(matchBannedNickname('badnameX', compiled)).toBeNull();
  });

  it('matches a substring rule case-insensitively', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'r1', pattern: 'hack', matchType: 'substring' }),
    ]);
    expect(matchBannedNickname('ProHACKer', compiled)).toMatchObject({ ruleId: 'r1' });
  });

  it('matches a regex rule case-insensitively', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'r1', pattern: '^\\[admin\\]', matchType: 'regex' }),
    ]);
    expect(matchBannedNickname('[ADMIN]Bob', compiled)).toMatchObject({ ruleId: 'r1' });
    expect(matchBannedNickname('Bob[admin]', compiled)).toBeNull();
  });

  it('prefers an exact match over a substring rule that also matches', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'substring-rule', pattern: 'cheat', matchType: 'substring' }),
      rule({ id: 'exact-rule', pattern: 'cheater', matchType: 'exact' }),
    ]);
    expect(matchBannedNickname('cheater', compiled)).toMatchObject({ ruleId: 'exact-rule' });
  });

  it('prefers a substring match over a regex rule that also matches', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'regex-rule', pattern: 'ch.*ter', matchType: 'regex' }),
      rule({ id: 'substring-rule', pattern: 'cheater', matchType: 'substring' }),
    ]);
    expect(matchBannedNickname('cheater', compiled)).toMatchObject({ ruleId: 'substring-rule' });
  });

  it('returns the first match within a tier in compile (creation) order', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'first', pattern: 'cheat', matchType: 'substring' }),
      rule({ id: 'second', pattern: 'cheater', matchType: 'substring' }),
    ]);
    expect(matchBannedNickname('cheater', compiled)).toMatchObject({ ruleId: 'first' });
  });

  it('drops an invalid regex pattern silently instead of throwing', () => {
    expect(() =>
      compileBannedNameRules([rule({ id: 'r1', pattern: '(unterminated', matchType: 'regex' })]),
    ).not.toThrow();
    const compiled = compileBannedNameRules([
      rule({ id: 'r1', pattern: '(unterminated', matchType: 'regex' }),
    ]);
    expect(matchBannedNickname('(unterminated', compiled)).toBeNull();
  });

  it('drops an empty or over-length pattern', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'empty', pattern: '', matchType: 'substring' }),
      rule({ id: 'toolong', pattern: 'x'.repeat(257), matchType: 'substring' }),
    ]);
    expect(matchBannedNickname('x'.repeat(300), compiled)).toBeNull();
  });

  it('carries the rule reason and action through to the match', () => {
    const compiled = compileBannedNameRules([
      rule({
        id: 'r1',
        pattern: 'toxic',
        matchType: 'substring',
        reason: 'toxicity',
        action: 'alert',
      }),
    ]);
    expect(matchBannedNickname('toxicPlayer', compiled)).toEqual({
      ruleId: 'r1',
      matchType: 'substring',
      reason: 'toxicity',
      action: 'alert',
    });
  });
});
