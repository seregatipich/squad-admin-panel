import { describe, expect, it } from 'vitest';
import {
  BONUS_LIMIT,
  buildApiQuery,
  buildQueryString,
  parsePeriod,
  playerHref,
  valueColumnLabel,
} from './helpers';

describe('parsePeriod', () => {
  it('defaults to all', () => {
    expect(parsePeriod(new URLSearchParams())).toBe('all');
  });

  it('accepts 30d', () => {
    expect(parsePeriod(new URLSearchParams('period=30d'))).toBe('30d');
  });

  it('falls back to all for junk values', () => {
    expect(parsePeriod(new URLSearchParams('period=7d'))).toBe('all');
    expect(parsePeriod(new URLSearchParams('period=balance'))).toBe('all');
  });
});

describe('buildQueryString', () => {
  it('is empty for the default period', () => {
    expect(buildQueryString('all')).toBe('');
  });

  it('carries the 30d period', () => {
    expect(buildQueryString('30d')).toBe('period=30d');
  });
});

describe('buildApiQuery', () => {
  it('sets period and the default limit', () => {
    expect(buildApiQuery('all')).toBe(`period=all&limit=${BONUS_LIMIT}`);
    expect(buildApiQuery('30d')).toBe(`period=30d&limit=${BONUS_LIMIT}`);
  });

  it('honours an explicit limit', () => {
    expect(buildApiQuery('all', 5)).toBe('period=all&limit=5');
  });
});

describe('valueColumnLabel', () => {
  it('labels the balance for all-time and accruals for 30d', () => {
    expect(valueColumnLabel('all')).toBe('Баланс');
    expect(valueColumnLabel('30d')).toBe('Начислено за 30 дней');
  });
});

describe('playerHref', () => {
  it('links to the player card', () => {
    expect(playerHref({ player_id: 'p-1' })).toBe('/players/p-1');
  });
});
