import { describe, expect, it } from 'vitest';
import { buildCheckUrl, ruleHref } from './nick-ban';

describe('buildCheckUrl', () => {
  it('encodes a plain nickname', () => {
    expect(buildCheckUrl('BadPlayer')).toBe('/api/v1/banned-names/check?nick=BadPlayer');
  });

  it('encodes special characters (&, #, spaces)', () => {
    expect(buildCheckUrl('Bad & Ugly #1')).toBe(
      '/api/v1/banned-names/check?nick=Bad%20%26%20Ugly%20%231',
    );
  });

  it('encodes cyrillic nicknames', () => {
    expect(buildCheckUrl('Игрок')).toBe(
      `/api/v1/banned-names/check?nick=${encodeURIComponent('Игрок')}`,
    );
  });
});

describe('ruleHref', () => {
  it('links to the banned-names page with a ?rule= param', () => {
    expect(ruleHref('rule-123')).toBe('/banned-names?rule=rule-123');
  });

  it('encodes special characters in the rule id', () => {
    expect(ruleHref('a b&c')).toBe('/banned-names?rule=a%20b%26c');
  });
});
