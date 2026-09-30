import { describe, expect, it } from 'vitest';
import { parsePlayerVoteStats, serialSkipperLabel, voteStatsUrl } from './votes';

describe('serialSkipperLabel', () => {
  it('summarizes the skip count, window and threshold', () => {
    expect(serialSkipperLabel({ flagged: true, skip_count: 5, threshold: 5, window_days: 7 })).toBe(
      '5 скипов за 7 дн. (порог 5)',
    );
  });
});

describe('parsePlayerVoteStats', () => {
  const valid = {
    player_id: 'p-1',
    initiated: 3,
    participated: 10,
    serial_skipper: { flagged: false, skip_count: 1, threshold: 5, window_days: 7 },
  };

  it('accepts a well-formed body', () => {
    expect(parsePlayerVoteStats(valid)).toEqual(valid);
  });

  // Regression (#468): a JSON error answered with 200 crashed the card on
  // `data.initiated.toLocaleString`.
  it('rejects bodies missing counters or the serial-skipper block', () => {
    expect(parsePlayerVoteStats({ error: 'boom' })).toBeNull();
    expect(parsePlayerVoteStats({ ...valid, initiated: '3' })).toBeNull();
    expect(parsePlayerVoteStats({ ...valid, serial_skipper: { flagged: 'no' } })).toBeNull();
    expect(parsePlayerVoteStats(null)).toBeNull();
  });
});

describe('voteStatsUrl', () => {
  it('encodes the player id', () => {
    expect(voteStatsUrl('../x')).toBe('/api/v1/players/..%2Fx/vote-stats');
  });
});
