import { describe, expect, it } from 'vitest';
import { getBssSiteUrl } from './bss-site';

describe('getBssSiteUrl', () => {
  it('uses the canonical site when the environment is absent', () => {
    expect(getBssSiteUrl(undefined, 'production')).toBe('https://bss.games');
  });

  it('normalizes an exact trusted origin', () => {
    expect(getBssSiteUrl('https://bss.games/', 'production')).toBe('https://bss.games');
  });

  it.each([
    'javascript:alert(1)',
    'https://bss.games/cabinet',
    'https://user:password@bss.games',
    'http://bss.games',
  ])('rejects an unsafe production value: %s', (value) => {
    expect(() => getBssSiteUrl(value, 'production')).toThrow('BSS_SITE_URL');
  });
});
