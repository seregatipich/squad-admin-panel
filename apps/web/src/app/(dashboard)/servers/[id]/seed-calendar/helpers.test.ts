import { describe, expect, it } from 'vitest';
import {
  bucketByDay,
  dayKey,
  expandOccurrences,
  type SeedScheduleEntry,
  startOfWeekUtc,
  weekDays,
} from './helpers';

function makeEntry(overrides: Partial<SeedScheduleEntry> = {}): SeedScheduleEntry {
  return {
    id: 'entry-1',
    server_id: 'srv-1',
    starts_at: '2026-07-11T10:00:00.000Z',
    seed_layer: 'Sumari Seed v1',
    broadcast_text: null,
    notify_minutes_before: 0,
    recurrence: null,
    enabled: true,
    created_by: null,
    last_executed_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('expandOccurrences', () => {
  const rangeFrom = new Date('2026-07-01T00:00:00.000Z');
  const rangeTo = new Date('2026-07-14T23:59:00.000Z');

  it('includes a one-off entry whose starts_at falls inside the range', () => {
    const entry = makeEntry({ starts_at: '2026-07-05T12:00:00.000Z' });
    const occurrences = expandOccurrences([entry], rangeFrom, rangeTo);
    expect(occurrences).toEqual([
      {
        entryId: entry.id,
        startsAt: new Date('2026-07-05T12:00:00.000Z'),
        seedLayer: entry.seed_layer,
        broadcastText: null,
        recurrence: null,
      },
    ]);
  });

  it('excludes a one-off entry whose starts_at falls outside the range', () => {
    const entry = makeEntry({ starts_at: '2026-08-01T12:00:00.000Z' });
    expect(expandOccurrences([entry], rangeFrom, rangeTo)).toEqual([]);
  });

  it('excludes a disabled entry entirely, one-off or recurring', () => {
    const oneOff = makeEntry({ starts_at: '2026-07-05T12:00:00.000Z', enabled: false });
    const recurring = makeEntry({
      id: 'entry-2',
      recurrence: '0 10 * * 6',
      enabled: false,
    });
    expect(expandOccurrences([oneOff, recurring], rangeFrom, rangeTo)).toEqual([]);
  });

  it('yields every Saturday 10:00 UTC in range for a weekly cron entry', () => {
    const entry = makeEntry({
      recurrence: '0 10 * * 6',
      starts_at: '2026-07-01T00:00:00.000Z',
    });
    const occurrences = expandOccurrences([entry], rangeFrom, rangeTo);
    expect(occurrences.map((o) => o.startsAt.toISOString())).toEqual([
      '2026-07-04T10:00:00.000Z',
      '2026-07-11T10:00:00.000Z',
    ]);
    expect(occurrences.every((o) => o.recurrence === '0 10 * * 6')).toBe(true);
  });

  it('never yields a recurring occurrence before the entry starts_at', () => {
    const entry = makeEntry({
      recurrence: '0 10 * * 6',
      starts_at: '2026-07-06T00:00:00.000Z', // after the first Saturday in range
    });
    const occurrences = expandOccurrences([entry], rangeFrom, rangeTo);
    expect(occurrences.map((o) => o.startsAt.toISOString())).toEqual(['2026-07-11T10:00:00.000Z']);
  });

  it('sorts occurrences from multiple entries earliest-first', () => {
    const later = makeEntry({ id: 'later', starts_at: '2026-07-08T00:00:00.000Z' });
    const earlier = makeEntry({ id: 'earlier', starts_at: '2026-07-02T00:00:00.000Z' });
    const occurrences = expandOccurrences([later, earlier], rangeFrom, rangeTo);
    expect(occurrences.map((o) => o.entryId)).toEqual(['earlier', 'later']);
  });
});

describe('startOfWeekUtc / weekDays', () => {
  it('resolves the Monday of the week for a mid-week date', () => {
    // 2026-07-15 is a Wednesday.
    expect(startOfWeekUtc(new Date('2026-07-15T14:30:00.000Z')).toISOString()).toBe(
      '2026-07-13T00:00:00.000Z',
    );
  });

  it('resolves Sunday itself to the preceding Monday', () => {
    // 2026-07-19 is a Sunday.
    expect(startOfWeekUtc(new Date('2026-07-19T23:00:00.000Z')).toISOString()).toBe(
      '2026-07-13T00:00:00.000Z',
    );
  });

  it('produces 7 consecutive UTC midnights starting at weekStart', () => {
    const weekStart = new Date('2026-07-13T00:00:00.000Z');
    const days = weekDays(weekStart);
    expect(days.map((d) => d.toISOString())).toEqual([
      '2026-07-13T00:00:00.000Z',
      '2026-07-14T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z',
    ]);
  });
});

describe('dayKey / bucketByDay', () => {
  it('formats a date as its UTC calendar-day key', () => {
    expect(dayKey(new Date('2026-07-11T23:59:59.000Z'))).toBe('2026-07-11');
  });

  it('groups items by their UTC calendar day', () => {
    const items = [
      { at: new Date('2026-07-11T08:00:00.000Z'), label: 'a' },
      { at: new Date('2026-07-11T20:00:00.000Z'), label: 'b' },
      { at: new Date('2026-07-12T08:00:00.000Z'), label: 'c' },
    ];
    const buckets = bucketByDay(items, (item) => item.at);
    expect(buckets.get('2026-07-11')?.map((i) => i.label)).toEqual(['a', 'b']);
    expect(buckets.get('2026-07-12')?.map((i) => i.label)).toEqual(['c']);
  });
});
