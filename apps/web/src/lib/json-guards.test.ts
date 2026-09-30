import { describe, expect, it } from 'vitest';
import {
  isArrayOf,
  isFiniteNumber,
  isNullableNumber,
  isNullableString,
  isRecord,
} from './json-guards';

describe('json guards', () => {
  it('accepts only plain objects as records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('accepts only finite numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
  });

  it('accepts null alongside the base type for the nullable guards', () => {
    expect(isNullableString(null)).toBe(true);
    expect(isNullableString('a')).toBe(true);
    expect(isNullableString(undefined)).toBe(false);
    expect(isNullableNumber(null)).toBe(true);
    expect(isNullableNumber(2)).toBe(true);
    expect(isNullableNumber('2')).toBe(false);
  });

  it('checks every element of an array', () => {
    expect(isArrayOf([1, 2], isFiniteNumber)).toBe(true);
    expect(isArrayOf([1, '2'], isFiniteNumber)).toBe(false);
    expect(isArrayOf(null, isFiniteNumber)).toBe(false);
  });
});
