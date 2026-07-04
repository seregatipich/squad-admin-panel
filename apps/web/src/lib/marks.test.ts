import { describe, expect, it } from 'vitest';
import {
  availableMarkTypes,
  type MarkTypeOption,
  type PlayerMark,
  partitionMarks,
  severityTone,
} from './marks';

function makeType(id: number, sortOrder: number): MarkTypeOption {
  return {
    id,
    slug: `type-${id}`,
    label_en: `Type ${id}`,
    label_ru: `Тип ${id}`,
    icon: 'flag',
    severity: id,
    sort_order: sortOrder,
  };
}

function makeMark(id: string, markTypeId: number, active: boolean): PlayerMark {
  return {
    id,
    player_id: 'p1',
    mark_type_id: markTypeId,
    comment: null,
    created_by: 'author',
    created_by_name: 'Author',
    created_at: '2026-07-04T00:00:00.000Z',
    cleared_by: active ? null : 'clearer',
    cleared_by_name: active ? null : 'Clearer',
    cleared_at: active ? null : '2026-07-04T01:00:00.000Z',
    clear_reason: active ? null : 'reason',
    active,
    mark_type: {
      id: markTypeId,
      slug: `type-${markTypeId}`,
      label_en: `Type ${markTypeId}`,
      label_ru: `Тип ${markTypeId}`,
      icon: 'flag',
      severity: markTypeId,
    },
  };
}

describe('partitionMarks', () => {
  it('splits marks into active and cleared buckets', () => {
    const { active, cleared } = partitionMarks([
      makeMark('m1', 1, true),
      makeMark('m2', 2, false),
      makeMark('m3', 3, true),
    ]);
    expect(active.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(cleared.map((m) => m.id)).toEqual(['m2']);
  });

  it('returns empty buckets for no marks', () => {
    expect(partitionMarks([])).toEqual({ active: [], cleared: [] });
  });
});

describe('availableMarkTypes', () => {
  it('excludes types that already have an active mark and sorts by sort_order', () => {
    const types = [makeType(3, 3), makeType(1, 1), makeType(2, 2)];
    const activeMarks = [makeMark('m1', 2, true)];
    const options = availableMarkTypes(types, activeMarks);
    expect(options.map((t) => t.id)).toEqual([1, 3]);
  });

  it('ignores cleared marks when computing availability', () => {
    const types = [makeType(1, 1), makeType(2, 2)];
    const activeMarks = partitionMarks([makeMark('m1', 1, false)]).active;
    const options = availableMarkTypes(types, activeMarks);
    expect(options.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('severityTone', () => {
  it('maps severity bands to tones', () => {
    expect(severityTone(5)).toBe('red');
    expect(severityTone(4)).toBe('amber');
    expect(severityTone(3)).toBe('amber');
    expect(severityTone(1)).toBe('neutral');
  });
});
