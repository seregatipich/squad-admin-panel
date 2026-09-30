import { describe, expect, it } from 'vitest';
import { COPLAY_CARD_LIMIT, coplayUrl, parseCoplayPartners } from './coplay';

const partner = {
  player_id: 'p-1',
  player_name: 'Друг',
  overlap_seconds: 3600,
  shared_session_count: 7,
};

describe('coplayUrl', () => {
  // Regression (#453): the card fetched the API's top 20 and sliced 10.
  it('asks the API for exactly the partners the card shows, without the per-server split', () => {
    expect(coplayUrl('player-1')).toBe(
      `/api/v1/players/player-1/coplay?limit=${COPLAY_CARD_LIMIT}`,
    );
    expect(COPLAY_CARD_LIMIT).toBe(10);
  });

  it('encodes the player id', () => {
    expect(coplayUrl('../x')).toBe(`/api/v1/players/..%2Fx/coplay?limit=${COPLAY_CARD_LIMIT}`);
  });
});

describe('parseCoplayPartners', () => {
  it('returns the partners of a well-formed body', () => {
    expect(parseCoplayPartners({ partners: [partner, { ...partner, player_name: null }] })).toEqual(
      [partner, { ...partner, player_name: null }],
    );
  });

  it('rejects a body whose partners are missing or malformed (#456)', () => {
    expect(parseCoplayPartners({})).toBeNull();
    expect(parseCoplayPartners({ partners: [{ ...partner, overlap_seconds: '1' }] })).toBeNull();
    expect(parseCoplayPartners(null)).toBeNull();
  });
});
