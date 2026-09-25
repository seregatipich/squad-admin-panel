import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventsAppendedCoalescer,
  type EventsAppendedBatch,
  parseEventsAppendedPayload,
} from '../src/plugins/events-feed.js';

describe('parseEventsAppendedPayload', () => {
  it('reads the trigger payload', () => {
    expect(parseEventsAppendedPayload('{"server_id":"s1","kind":"player.connected"}')).toEqual({
      server_id: 's1',
      kind: 'player.connected',
    });
    expect(parseEventsAppendedPayload('{"server_id":null,"kind":"bansync.completed"}')).toEqual({
      server_id: null,
      kind: 'bansync.completed',
    });
  });

  it.each([
    '{',
    'null',
    '"text"',
    '{"server_id":"s1"}',
    '{"server_id":"s1","kind":""}',
    '{"server_id":5,"kind":"x"}',
  ])('drops malformed payload %s', (raw) => {
    expect(parseEventsAppendedPayload(raw)).toBeNull();
  });
});

describe('createEventsAppendedCoalescer', () => {
  afterEach(() => vi.useRealTimers());

  it('emits one sorted batch per server after the debounce window', () => {
    vi.useFakeTimers();
    const batches: EventsAppendedBatch[] = [];
    const c = createEventsAppendedCoalescer((b) => batches.push(b), 100);
    c.push('{"server_id":"a","kind":"combat_death"}');
    c.push('{"server_id":"a","kind":"combat_damage"}');
    c.push('{"server_id":"a","kind":"combat_damage"}');
    c.push('{"server_id":null,"kind":"bansync.completed"}');
    c.push('not json');
    vi.advanceTimersByTime(99);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([
      { server_id: 'a', kinds: ['combat_damage', 'combat_death'] },
      { server_id: null, kinds: ['bansync.completed'] },
    ]);

    // The next notification opens a fresh window.
    c.push('{"server_id":"a","kind":"match.started"}');
    vi.advanceTimersByTime(100);
    expect(batches.at(-1)).toEqual({ server_id: 'a', kinds: ['match.started'] });
  });

  it('does not arm the timer for malformed payloads and emits nothing after stop', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const c = createEventsAppendedCoalescer(emit, 50);
    c.push('garbage');
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
    c.push('{"server_id":"a","kind":"x"}');
    c.stop();
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
  });
});
