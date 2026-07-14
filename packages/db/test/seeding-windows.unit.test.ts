import { describe, expect, it } from 'vitest';
import {
  computeSeedingWindows,
  computeSeedSecondsWithinWindows,
  type SeedingTransitionEvent,
  type SeedingWindow,
  type SeedSessionInterval,
} from '../src/economy/accrual.js';

const DAY_START = 1_800_000_000;
const DAY_SECONDS = 86_400;
const DAY_END = DAY_START + DAY_SECONDS;

function started(atSec: number): SeedingTransitionEvent {
  return { type: 'started', atSec };
}
function ended(atSec: number): SeedingTransitionEvent {
  return { type: 'ended', atSec };
}

describe('computeSeedingWindows', () => {
  it('returns a single window for a started/ended pair inside the day', () => {
    const windows = computeSeedingWindows(
      [started(DAY_START + 100), ended(DAY_START + 500)],
      DAY_START,
      DAY_END,
    );
    expect(windows).toEqual([{ startSec: DAY_START + 100, endSec: DAY_START + 500 }]);
  });

  it('clips a window still open at dayEnd (no matching ended) to dayEnd/now', () => {
    const nowClippedEnd = DAY_START + 200; // caller passes min(now, dayEnd)
    const windows = computeSeedingWindows([started(DAY_START + 50)], DAY_START, nowClippedEnd);
    expect(windows).toEqual([{ startSec: DAY_START + 50, endSec: nowClippedEnd }]);
  });

  it('recovers a server already seeding at day start from the pre-day transition', () => {
    const windows = computeSeedingWindows(
      [started(DAY_START - 1000), ended(DAY_START + 300)],
      DAY_START,
      DAY_END,
    );
    expect(windows).toEqual([{ startSec: DAY_START, endSec: DAY_START + 300 }]);
  });

  it('collapses a duplicate started event while already seeding', () => {
    const windows = computeSeedingWindows(
      [started(DAY_START + 10), started(DAY_START + 50), ended(DAY_START + 400)],
      DAY_START,
      DAY_END,
    );
    expect(windows).toEqual([{ startSec: DAY_START + 10, endSec: DAY_START + 400 }]);
  });

  it('ignores a duplicate ended event while already live', () => {
    const windows = computeSeedingWindows(
      [started(DAY_START + 10), ended(DAY_START + 400), ended(DAY_START + 450)],
      DAY_START,
      DAY_END,
    );
    expect(windows).toEqual([{ startSec: DAY_START + 10, endSec: DAY_START + 400 }]);
  });

  it('handles an ended-without-started before day start (server was live) as a no-op', () => {
    const windows = computeSeedingWindows(
      [ended(DAY_START - 5000), started(DAY_START + 100), ended(DAY_START + 200)],
      DAY_START,
      DAY_END,
    );
    expect(windows).toEqual([{ startSec: DAY_START + 100, endSec: DAY_START + 200 }]);
  });

  it('returns no windows for empty input', () => {
    expect(computeSeedingWindows([], DAY_START, DAY_END)).toEqual([]);
  });

  it('leaves the whole day as one window when seeding started before day start and never ends', () => {
    const windows = computeSeedingWindows([started(DAY_START - 100)], DAY_START, DAY_END);
    expect(windows).toEqual([{ startSec: DAY_START, endSec: DAY_END }]);
  });
});

describe('computeSeedSecondsWithinWindows', () => {
  const window: SeedingWindow = { startSec: DAY_START + 1000, endSec: DAY_START + 2000 };

  function interval(overrides: Partial<SeedSessionInterval> = {}): SeedSessionInterval {
    return {
      playerId: 'p1',
      serverId: 's1',
      startSec: DAY_START,
      endSec: DAY_START + 100,
      ...overrides,
    };
  }

  it('counts a session fully inside the window in full', () => {
    const result = computeSeedSecondsWithinWindows(
      [interval({ startSec: DAY_START + 1200, endSec: DAY_START + 1500 })],
      new Map([['s1', [window]]]),
    );
    expect(result.get('p1|s1')).toBe(300);
  });

  it('counts only the in-window portion of a session crossing the seeding→live boundary', () => {
    // Session runs from before the window into the middle of it: only the overlap counts.
    const result = computeSeedSecondsWithinWindows(
      [interval({ startSec: DAY_START + 500, endSec: DAY_START + 1600 })],
      new Map([['s1', [window]]]),
    );
    expect(result.get('p1|s1')).toBe(600); // [1000, 1600)
  });

  it('excludes a session entirely outside the window', () => {
    const result = computeSeedSecondsWithinWindows(
      [interval({ startSec: DAY_START, endSec: DAY_START + 100 })],
      new Map([['s1', [window]]]),
    );
    expect(result.has('p1|s1')).toBe(false);
  });

  it('keys multiple servers independently', () => {
    const window2: SeedingWindow = { startSec: DAY_START, endSec: DAY_START + 50_000 };
    const result = computeSeedSecondsWithinWindows(
      [
        interval({ serverId: 's1', startSec: DAY_START + 1100, endSec: DAY_START + 1300 }),
        interval({ serverId: 's2', startSec: DAY_START + 10, endSec: DAY_START + 20 }),
      ],
      new Map([
        ['s1', [window]],
        ['s2', [window2]],
      ]),
    );
    expect(result.get('p1|s1')).toBe(200);
    expect(result.get('p1|s2')).toBe(10);
  });
});
