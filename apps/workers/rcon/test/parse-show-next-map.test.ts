import { describe, expect, it } from 'vitest';
import { parseShowNextMap } from '../src/parse-show-next-map.js';

describe('ShowNextMap parser', () => {
  it('parses a concrete next layer', () => {
    expect(parseShowNextMap('Next level is Fallujah, layer is Fallujah_RAAS_v1')).toEqual({
      level: 'Fallujah',
      layer: 'Fallujah_RAAS_v1',
    });
  });

  it('returns null fields while the next layer is still a vote', () => {
    expect(parseShowNextMap('Next level is , layer is To be voted')).toEqual({
      level: null,
      layer: null,
    });
  });

  it('returns null for empty or unexpected output', () => {
    expect(parseShowNextMap('')).toBeNull();
    expect(parseShowNextMap('Server received, But no response!!')).toBeNull();
  });
});
