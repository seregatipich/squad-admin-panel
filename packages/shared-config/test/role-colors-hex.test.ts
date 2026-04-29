import { describe, expect, it } from 'vitest';
import {
  isRoleColor,
  isRoleColorHex,
  isRoleColorPaletteName,
  roleColorToHex,
} from '../src/role-colors.js';

describe('role-colors with hex support', () => {
  it('accepts palette names', () => {
    expect(isRoleColor('red')).toBe(true);
    expect(isRoleColorPaletteName('red')).toBe(true);
    expect(isRoleColorHex('red')).toBe(false);
  });

  it('accepts #RRGGBB hex codes', () => {
    expect(isRoleColor('#FF0000')).toBe(true);
    expect(isRoleColor('#abcdef')).toBe(true);
    expect(isRoleColorHex('#FF0000')).toBe(true);
  });

  it('rejects malformed hex (#RGB short, missing #, 4-char)', () => {
    expect(isRoleColor('#FFF')).toBe(false);
    expect(isRoleColor('FF0000')).toBe(false);
    expect(isRoleColor('#FFFG00')).toBe(false);
  });

  it('roleColorToHex returns the hex itself for hex inputs (uppercased)', () => {
    expect(roleColorToHex('#abcdef')).toBe('#ABCDEF');
  });

  it('roleColorToHex maps palette names to a tailwind hex', () => {
    expect(roleColorToHex('red')).toBe('#EF4444');
    expect(roleColorToHex('neutral')).toBe('#737373');
  });

  it('roleColorToHex falls back to neutral for garbage', () => {
    expect(roleColorToHex('not-a-color')).toBe('#737373');
  });
});
