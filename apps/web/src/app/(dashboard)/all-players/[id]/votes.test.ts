import { describe, expect, it } from 'vitest';
import { serialSkipperLabel } from './votes';

describe('serialSkipperLabel', () => {
  it('summarizes the skip count, window and threshold', () => {
    expect(serialSkipperLabel({ flagged: true, skip_count: 5, threshold: 5, window_days: 7 })).toBe(
      '5 скипов за 7 дн. (порог 5)',
    );
  });
});
