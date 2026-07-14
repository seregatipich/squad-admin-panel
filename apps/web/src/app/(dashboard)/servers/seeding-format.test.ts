import { describe, expect, it } from 'vitest';
import { clampProgressPct, formatSeedProgress } from './seeding-format';

describe('formatSeedProgress', () => {
  it('formats "N / live_at"', () => {
    expect(formatSeedProgress(40, 60)).toBe('40 / 60');
  });

  it('renders "—" when current_players is null', () => {
    expect(formatSeedProgress(null, 60)).toBe('—');
  });

  it('renders "—" when live_at is null', () => {
    expect(formatSeedProgress(40, null)).toBe('—');
  });

  it('renders "0 / 60" for a fresh seeding period', () => {
    expect(formatSeedProgress(0, 60)).toBe('0 / 60');
  });
});

describe('clampProgressPct', () => {
  it('passes through an in-range value', () => {
    expect(clampProgressPct(66)).toBe(66);
  });

  it('clamps above 100 down to 100', () => {
    expect(clampProgressPct(150)).toBe(100);
  });

  it('clamps below 0 up to 0', () => {
    expect(clampProgressPct(-5)).toBe(0);
  });

  it('defaults null to 0', () => {
    expect(clampProgressPct(null)).toBe(0);
  });

  it('defaults undefined to 0', () => {
    expect(clampProgressPct(undefined)).toBe(0);
  });

  it('defaults NaN to 0', () => {
    expect(clampProgressPct(Number.NaN)).toBe(0);
  });
});
