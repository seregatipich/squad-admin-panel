import { describe, expect, it } from 'vitest';
import { type ChatFlagRule, countEnabled, describeRule, summarizeReindex } from './chatFlags';

function rule(overrides: Partial<ChatFlagRule>): ChatFlagRule {
  return {
    id: 'r1',
    pattern: 'bad',
    pattern_type: 'word',
    locale: 'all',
    enabled: true,
    created_by: null,
    author_name: null,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('describeRule', () => {
  it('summarizes an enabled russian word rule', () => {
    expect(describeRule(rule({ pattern_type: 'word', locale: 'ru' }))).toBe(
      'Слово · Русский · включено',
    );
  });

  it('summarizes a disabled regex rule', () => {
    expect(describeRule(rule({ pattern_type: 'regex', locale: 'en', enabled: false }))).toBe(
      'Регэксп · English · отключено',
    );
  });
});

describe('countEnabled', () => {
  it('counts only enabled rules', () => {
    expect(
      countEnabled([rule({ enabled: true }), rule({ enabled: false }), rule({ enabled: true })]),
    ).toBe(2);
  });

  it('returns zero for an empty list', () => {
    expect(countEnabled([])).toBe(0);
  });
});

describe('summarizeReindex', () => {
  it('renders a human summary', () => {
    expect(summarizeReindex({ days: 7, scanned: 100, flagged: 4, changed: 4 })).toBe(
      'Проверено 100, помечено 4, изменено 4 за 7 дн.',
    );
  });
});
