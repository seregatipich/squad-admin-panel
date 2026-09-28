import { describe, expect, it } from 'vitest';
import { sampleFor, sampleTimeOfDay } from './helpers';

describe('sampleFor', () => {
  it('chat_keyword: carries the configured keyword and a placeholder player', () => {
    expect(sampleFor('chat_keyword', { keyword: 'gg' })).toEqual({
      chat_message: 'gg',
      player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
    });
  });

  it('player_count with operator "gt": samples one above the threshold, not equal to it (#677)', () => {
    expect(sampleFor('player_count', { operator: 'gt', threshold: 10 })).toEqual({
      player_count: 11,
    });
  });

  it('player_count with operator "lt": samples one below the threshold, floored at 0', () => {
    expect(sampleFor('player_count', { operator: 'lt', threshold: 10 })).toEqual({
      player_count: 9,
    });
    expect(sampleFor('player_count', { operator: 'lt', threshold: 0 })).toEqual({
      player_count: 0,
    });
  });

  it('player_count with operator "eq"/"gte"/"lte": samples exactly the threshold', () => {
    expect(sampleFor('player_count', { operator: 'eq', threshold: 5 })).toEqual({
      player_count: 5,
    });
    expect(sampleFor('player_count', { operator: 'gte', threshold: 5 })).toEqual({
      player_count: 5,
    });
  });

  it('player_flag with present:true (default): includes the flag', () => {
    expect(sampleFor('player_flag', { flag: 'vip' })).toEqual({
      player_flags: ['vip'],
      player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
    });
  });

  it('player_flag with present:false: omits the flag so the "absent" case is actually testable (#677)', () => {
    expect(sampleFor('player_flag', { flag: 'vip', present: false })).toEqual({
      player_flags: [],
      player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
    });
  });

  it('time_of_day: samples a moment inside the configured window, not raw "now"', () => {
    // Reference "now" is outside the window (03:00 UTC); the window is
    // 10:00–11:00 UTC. A raw `new Date().toISOString()` sample would miss it.
    const referenceNow = new Date('2024-01-03T03:00:00.000Z'); // a Wednesday
    const result = sampleFor(
      'time_of_day',
      { timezone: 'UTC', startMinute: 600, endMinute: 660 },
      referenceNow,
    );
    const sampledMinuteOfDay = (() => {
      const d = new Date((result as { now: string }).now);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();
    expect(sampledMinuteOfDay).toBeGreaterThanOrEqual(600);
    expect(sampledMinuteOfDay).toBeLessThanOrEqual(660);
  });

  it('unknown condition type: returns an empty sample', () => {
    expect(sampleFor('something_else', {})).toEqual({});
  });
});

describe('sampleTimeOfDay', () => {
  it('honors a restricted weekday list by advancing to the next matching day', () => {
    // Wednesday (weekday 3); only Fridays (5) are allowed.
    const referenceNow = new Date('2024-01-03T12:00:00.000Z');
    const iso = sampleTimeOfDay({ timezone: 'UTC', startMinute: 0, weekdays: [5] }, referenceNow);
    const d = new Date(iso);
    expect(d.getUTCDay()).toBe(5);
  });

  it('falls back to the reference time for an invalid timezone rather than throwing', () => {
    const referenceNow = new Date('2024-01-03T12:00:00.000Z');
    expect(sampleTimeOfDay({ timezone: 'Not/AZone', startMinute: 0 }, referenceNow)).toBe(
      referenceNow.toISOString(),
    );
  });
});
