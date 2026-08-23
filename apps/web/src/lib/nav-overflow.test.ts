import { describe, expect, it } from 'vitest';
import { fitNavEntries } from './nav-overflow';

const MORE = 60;

describe('fitNavEntries', () => {
  it('keeps every entry in the bar while they all fit', () => {
    expect(fitNavEntries([100, 100, 100], 400, MORE)).toBe(3);
  });

  it('keeps every entry when they fill the bar exactly', () => {
    expect(fitNavEntries([100, 100, 100], 300, MORE)).toBe(3);
  });

  it('moves only the entries that do not fit, reserving room for the trigger', () => {
    // 300 available, 60 of it spoken for by «Ещё» → 240 for entries.
    expect(fitNavEntries([100, 100, 100], 300 + 1, MORE)).toBe(3);
    expect(fitNavEntries([100, 100, 100], 299, MORE)).toBe(2);
  });

  it('never lets the last fitting entry push the trigger off the edge', () => {
    // Without the reservation 240 would fit two entries and leave the trigger
    // hanging past the edge, which is the bug this replaces.
    expect(fitNavEntries([100, 100, 100], 240, MORE)).toBe(1);
  });

  it('moves everything into the menu when not even one entry fits', () => {
    expect(fitNavEntries([200, 200], 210, MORE)).toBe(0);
  });

  it('renders everything before the first measurement, rather than flashing collapsed', () => {
    expect(fitNavEntries([100, 100, 100], 0, MORE)).toBe(3);
    expect(fitNavEntries([100, 100, 100], -1, MORE)).toBe(3);
  });

  it('handles an empty bar', () => {
    expect(fitNavEntries([], 500, MORE)).toBe(0);
  });
});
