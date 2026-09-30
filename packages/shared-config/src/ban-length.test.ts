import { describe, expect, it } from 'vitest';
import { BAN_LENGTH_PATTERN, isValidBanLength } from './ban-length.js';

describe('isValidBanLength', () => {
  it('accepts a bare number of days', () => {
    expect(isValidBanLength('0')).toBe(true);
    expect(isValidBanLength('7')).toBe(true);
  });

  it('accepts a number with a unit suffix', () => {
    expect(isValidBanLength('3d')).toBe(true);
    expect(isValidBanLength('12h')).toBe(true);
    expect(isValidBanLength('2w')).toBe(true);
    expect(isValidBanLength('1M')).toBe(true);
    expect(isValidBanLength('1y')).toBe(true);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(isValidBanLength(' 3d ')).toBe(true);
  });

  it('rejects empty, non-numeric or malformed values', () => {
    expect(isValidBanLength('')).toBe(false);
    expect(isValidBanLength('x')).toBe(false);
    expect(isValidBanLength('1 d')).toBe(false);
    expect(isValidBanLength('-1')).toBe(false);
  });
});

describe('BAN_LENGTH_PATTERN', () => {
  it('exposes the amount and unit as capture groups', () => {
    const match = BAN_LENGTH_PATTERN.exec('12h');
    expect(match?.[1]).toBe('12');
    expect(match?.[2]).toBe('h');
  });

  it('leaves the unit group undefined for a bare number', () => {
    const match = BAN_LENGTH_PATTERN.exec('7');
    expect(match?.[1]).toBe('7');
    expect(match?.[2]).toBeUndefined();
  });
});
