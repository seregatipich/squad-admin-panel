import { describe, expect, it } from 'vitest';
import {
  highestSeverityTone,
  type MarkTypeOption,
  markIconEmoji,
  markTypeMenuItems,
  type PlayerMark,
  partitionMarks,
  severityTone,
} from './marks';

function makeType(id: number, sortOrder: number, severity = id): MarkTypeOption {
  return {
    id,
    slug: `type-${id}`,
    label_en: `Type ${id}`,
    label_ru: `Тип ${id}`,
    icon: 'crosshair',
    severity,
    sort_order: sortOrder,
  };
}

function makeMark(
  id: string,
  markTypeId: number,
  active: boolean,
  severity = markTypeId,
): PlayerMark {
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
      icon: 'crosshair',
      severity,
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

describe('markTypeMenuItems', () => {
  it('lists every type sorted by sort_order and flags the active ones', () => {
    const types = [makeType(3, 3), makeType(1, 1), makeType(2, 2)];
    const activeMark = makeMark('m1', 2, true);
    const items = markTypeMenuItems(types, [activeMark]);
    expect(items.map((entry) => entry.type.id)).toEqual([1, 2, 3]);
    expect(items.map((entry) => entry.activeMark?.id ?? null)).toEqual([null, 'm1', null]);
  });

  it('never treats a cleared mark as active in the menu', () => {
    const types = [makeType(1, 1), makeType(2, 2)];
    const clearedMark = makeMark('m1', 1, false);
    const items = markTypeMenuItems(types, partitionMarks([clearedMark]).active);
    expect(items.every((entry) => entry.activeMark === null)).toBe(true);
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

describe('highestSeverityTone', () => {
  it('returns null when there are no marks', () => {
    expect(highestSeverityTone([])).toBeNull();
  });

  it('picks the tone of the most severe mark', () => {
    expect(highestSeverityTone([{ severity: 1 }, { severity: 5 }, { severity: 3 }])).toBe('red');
    expect(highestSeverityTone([{ severity: 2 }, { severity: 3 }])).toBe('amber');
    expect(highestSeverityTone([{ severity: 1 }, { severity: 2 }])).toBe('neutral');
  });
});

describe('markIconEmoji', () => {
  it('maps known icon slugs to emoji', () => {
    expect(markIconEmoji('crosshair')).toBe('🎯');
    expect(markIconEmoji('skull')).toBe('💀');
  });

  it('falls back to a flag for unknown slugs', () => {
    expect(markIconEmoji('does-not-exist')).toBe('🚩');
  });
});
