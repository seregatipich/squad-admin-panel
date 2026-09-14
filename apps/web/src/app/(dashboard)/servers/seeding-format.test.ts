import { describe, expect, it } from 'vitest';
import { formatSeedProgress } from './seeding-format';

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
