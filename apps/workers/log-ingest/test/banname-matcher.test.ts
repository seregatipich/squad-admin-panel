import { describe, expect, it } from 'vitest';
import {
  type BannedNameRuleRow,
  compileBannedNameRules,
  matchBannedNickname,
  REGEX_MATCH_TIMEOUT_MS,
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

  // Audit #115 — a rule stored before the API refused unsafe regexes must not
  // be able to stall ingestion on a crafted nickname.
  it('drops a catastrophically backtracking regex rule', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'redos', pattern: '(a+)+$', matchType: 'regex' }),
    ]);
    expect(compiled.regex).toHaveLength(0);
    const started = Date.now();
    expect(matchBannedNickname(`${'a'.repeat(24)}!`, compiled)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
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

  it('drops a catastrophic-backtracking regex rule instead of running it (#52)', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'redos', pattern: '(a|aa)+$', matchType: 'regex' }),
    ]);
    expect(compiled.regex).toHaveLength(0);
    expect(matchBannedNickname('aaaa', compiled)).toBeNull();
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

describe('catastrophic-backtracking regex rules (#62)', () => {
  // Two layers guard the event loop: the static screen (audit #115,
  // `isSafeBannedNameRegex`) drops exponential shapes such as `^(a|a)*$` at
  // compile time, and the vm timeout (#62) is the backstop for patterns the
  // screen cannot see. `^a*a*a*a*a*a*a*a*b$` passes the screen but backtracks
  // polynomially (n^8). 60 characters need billions of steps, so the match runs
  // past the 50 ms budget on any machine (25 characters finished in time on a
  // fast CI runner), and only the vm timeout ends it.
  const slowPattern = '^a*a*a*a*a*a*a*a*b$';
  const evilNickname = `${'a'.repeat(60)}!`;

  it('drops exponential-backtracking rules at compile time', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'evil', pattern: '^(a|a)*$', matchType: 'regex' }),
    ]);

    expect(compiled.regex).toHaveLength(0);
  });

  it('gives up on a runaway regex rule within the match timeout instead of blocking the event loop', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'evil', pattern: slowPattern, matchType: 'regex' }),
    ]);

    const started = Date.now();
    const result = matchBannedNickname(evilNickname, compiled);
    const elapsedMs = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(REGEX_MATCH_TIMEOUT_MS * 10);
  });

  it('still evaluates the rules after a runaway regex rule', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'evil', pattern: slowPattern, matchType: 'regex' }),
      rule({ id: 'bang', pattern: '!$', matchType: 'regex' }),
    ]);

    expect(matchBannedNickname(evilNickname, compiled)).toMatchObject({ ruleId: 'bang' });
  });

  it('reports the rule that timed out so an operator can fix it', () => {
    const compiled = compileBannedNameRules([
      rule({ id: 'evil', pattern: slowPattern, matchType: 'regex' }),
    ]);
    const timedOut: string[] = [];

    matchBannedNickname(evilNickname, compiled, { onRegexTimeout: (id) => timedOut.push(id) });

    expect(timedOut).toEqual(['evil']);
  });
});
