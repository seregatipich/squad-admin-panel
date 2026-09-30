import { describe, expect, it } from 'vitest';
import {
  computeSeedSecondsByPlayerServer,
  daysInWindow,
  type SeedSessionInterval,
} from '../src/economy/accrual.js';

const SERVER_1 = 'srv-1';
const SERVER_2 = 'srv-2';

function interval(
  playerId: string,
  serverId: string,
  startSec: number,
  endSec: number,
): SeedSessionInterval {
  return { playerId, serverId, startSec, endSec };
}

describe('computeSeedSecondsByPlayerServer', () => {
  it('counts full session time when concurrency stays below the threshold', () => {
    const seed = computeSeedSecondsByPlayerServer([interval('p1', SERVER_1, 0, 3600)], 40);
    expect(seed.get(`p1|${SERVER_1}`)).toBe(3600);
  });

  it('excludes time where concurrency reaches the threshold', () => {
    // threshold = 2: while both p1 and p2 overlap, concurrency = 2 (not < 2),
    // so the overlap is not seed time; the solo tails are.
    const seed = computeSeedSecondsByPlayerServer(
      [
        interval('p1', SERVER_1, 0, 3000), // solo 0..1000, shared 1000..3000
        interval('p2', SERVER_1, 1000, 4000), // shared 1000..3000, solo 3000..4000
      ],
      2,
    );
    expect(seed.get(`p1|${SERVER_1}`)).toBe(1000);
    expect(seed.get(`p2|${SERVER_1}`)).toBe(1000);
  });

  it('treats a threshold of zero (or below) as never seed', () => {
    const seed = computeSeedSecondsByPlayerServer([interval('p1', SERVER_1, 0, 3600)], 0);
    expect(seed.size).toBe(0);
  });

  it('scopes concurrency per server', () => {
    // Two players on two different servers: each is alone on its own server.
    const seed = computeSeedSecondsByPlayerServer(
      [interval('p1', SERVER_1, 0, 3600), interval('p2', SERVER_2, 0, 3600)],
      2,
    );
    expect(seed.get(`p1|${SERVER_1}`)).toBe(3600);
    expect(seed.get(`p2|${SERVER_2}`)).toBe(3600);
  });

  it('ignores empty and inverted intervals', () => {
    const seed = computeSeedSecondsByPlayerServer(
      [interval('p1', SERVER_1, 100, 100), interval('p2', SERVER_1, 500, 200)],
      40,
    );
    expect(seed.size).toBe(0);
  });
});

describe('daysInWindow', () => {
  it('returns an inclusive list of UTC day keys', () => {
    expect(daysInWindow('2026-07-04', '2026-07-06')).toEqual([
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
    ]);
  });

  it('returns a single day when from === to', () => {
    expect(daysInWindow('2026-07-05', '2026-07-05')).toEqual(['2026-07-05']);
  });

  it('returns empty when the window is inverted', () => {
    expect(daysInWindow('2026-07-06', '2026-07-04')).toEqual([]);
  });
});

describe('computeSeedSecondsByPlayerServer scaling', () => {
  function bruteForce(intervals: SeedSessionInterval[], threshold: number): Map<string, number> {
    const result = new Map<string, number>();
    const boundaries = [...new Set(intervals.flatMap((i) => [i.startSec, i.endSec]))].sort(
      (a, b) => a - b,
    );
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const from = boundaries[i] as number;
      const to = boundaries[i + 1] as number;
      const active = intervals.filter((s) => s.startSec <= from && s.endSec >= to);
      if (active.length === 0 || active.length >= threshold) continue;
      for (const s of active) {
        const key = `${s.playerId}|${s.serverId}`;
        result.set(key, (result.get(key) ?? 0) + (to - from));
      }
    }
    return result;
  }

  function pseudoRandomIntervals(count: number, span: number): SeedSessionInterval[] {
    let state = 12345;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    return Array.from({ length: count }, (_, index) => {
      const startSec = Math.floor(next() * span);
      return interval(`p${index}`, SERVER_1, startSec, startSec + 1 + Math.floor(next() * 600));
    });
  }

  it('matches a brute-force evaluation on overlapping sessions', () => {
    const intervals = pseudoRandomIntervals(300, 5_000);
    expect(computeSeedSecondsByPlayerServer(intervals, 8)).toEqual(bruteForce(intervals, 8));
  });

  it('handles tens of thousands of sessions on one server without quadratic blow-up', () => {
    const intervals = pseudoRandomIntervals(40_000, 86_400);
    const startedAt = performance.now();
    computeSeedSecondsByPlayerServer(intervals, 40);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
