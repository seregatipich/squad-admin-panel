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
