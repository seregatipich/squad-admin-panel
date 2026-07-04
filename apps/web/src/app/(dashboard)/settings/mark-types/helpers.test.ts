import { describe, expect, it } from 'vitest';
import {
  isSameOrder,
  isValidSlug,
  MARK_TYPE_ICONS,
  type MarkType,
  moveItem,
  severityLabel,
  sortByOrder,
} from './helpers';

function makeType(id: number, sortOrder: number): MarkType {
  return {
    id,
    slug: `type_${id}`,
    label_en: `Type ${id}`,
    label_ru: `Тип ${id}`,
    icon: 'flag',
    severity: 3,
    is_active: true,
    sort_order: sortOrder,
  };
}

describe('isValidSlug', () => {
  it('accepts lowercase snake_case slugs of valid length', () => {
    expect(isValidSlug('wallhack')).toBe(true);
    expect(isValidSlug('object_spawn')).toBe(true);
    expect(isValidSlug('ab')).toBe(true);
  });

  it('rejects empty, too-short, uppercase, or illegal-character slugs', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('WallHack')).toBe(false);
    expect(isValidSlug('with space')).toBe(false);
    expect(isValidSlug('dash-not-ok')).toBe(false);
    expect(isValidSlug('a'.repeat(41))).toBe(false);
  });
});

describe('severityLabel', () => {
  it('maps known severities to Russian labels', () => {
    expect(severityLabel(1)).toBe('Низкая');
    expect(severityLabel(5)).toBe('Критическая');
  });

  it('falls back for unknown severities', () => {
    expect(severityLabel(9)).toBe('Уровень 9');
  });
});

describe('moveItem', () => {
  it('moves an item forward and shifts the rest', () => {
    const result = moveItem([1, 2, 3, 4], 0, 2);
    expect(result).toEqual([2, 3, 1, 4]);
  });

  it('moves an item backward', () => {
    const result = moveItem([1, 2, 3, 4], 3, 1);
    expect(result).toEqual([1, 4, 2, 3]);
  });

  it('clamps an out-of-range destination', () => {
    expect(moveItem([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
  });

  it('returns a copy when the source index is invalid', () => {
    const source = [1, 2, 3];
    const result = moveItem(source, 5, 0);
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(source);
  });
});

describe('sortByOrder', () => {
  it('orders types ascending by sort_order without mutating input', () => {
    const source = [makeType(3, 3), makeType(1, 1), makeType(2, 2)];
    const sorted = sortByOrder(source);
    expect(sorted.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(source.map((t) => t.id)).toEqual([3, 1, 2]);
  });
});

describe('isSameOrder', () => {
  it('detects identical id sequences', () => {
    const left = [makeType(1, 1), makeType(2, 2)];
    const right = [makeType(1, 5), makeType(2, 6)];
    expect(isSameOrder(left, right)).toBe(true);
  });

  it('detects reordered or differently sized sequences', () => {
    const left = [makeType(1, 1), makeType(2, 2)];
    expect(isSameOrder(left, [makeType(2, 1), makeType(1, 2)])).toBe(false);
    expect(isSameOrder(left, [makeType(1, 1)])).toBe(false);
  });
});

describe('MARK_TYPE_ICONS', () => {
  it('includes the eight seeded icons', () => {
    for (const icon of [
      'scan-eye',
      'crosshair',
      'gauge',
      'boxes',
      'refresh-cw',
      'skull',
      'file-warning',
      'message-square-warning',
    ]) {
      expect(MARK_TYPE_ICONS).toContain(icon);
    }
  });
});
