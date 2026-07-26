import { describe, expect, it } from 'vitest';
import {
  buildPlayersListQuery,
  DEFAULT_SORT_STATE,
  nextSortState,
  type PlayerSortState,
  SORT_GLYPH_ASC,
  SORT_GLYPH_DESC,
  SORT_GLYPH_INACTIVE,
  sortIndicator,
} from './helpers';

describe('nextSortState', () => {
  it('nextSortState flips the direction when the active column is clicked again', () => {
    expect(nextSortState({ key: 'last_seen', dir: 'desc' }, 'last_seen')).toEqual({
      key: 'last_seen',
      dir: 'asc',
    });
  });

  it('nextSortState flips back on a third click of the same column', () => {
    const once = nextSortState(DEFAULT_SORT_STATE, 'last_seen');
    const twice = nextSortState(once, 'last_seen');
    expect(twice).toEqual({ key: 'last_seen', dir: 'desc' });
  });

  it('nextSortState switches column and applies that column default direction', () => {
    expect(nextSortState({ key: 'nickname', dir: 'desc' }, 'total_time')).toEqual({
      key: 'total_time',
      dir: 'desc',
    });
    expect(nextSortState({ key: 'last_seen', dir: 'asc' }, 'created')).toEqual({
      key: 'created',
      dir: 'desc',
    });
  });

  it('nextSortState starts the nickname column ascending', () => {
    expect(nextSortState(DEFAULT_SORT_STATE, 'nickname')).toEqual({
      key: 'nickname',
      dir: 'asc',
    });
  });
});

describe('sortIndicator', () => {
  const active: PlayerSortState = { key: 'created', dir: 'asc' };

  it('sortIndicator returns the neutral glyph for an inactive column', () => {
    expect(sortIndicator(active, 'nickname')).toBe(SORT_GLYPH_INACTIVE);
  });

  it('sortIndicator returns the ascending glyph for the active ascending column', () => {
    expect(sortIndicator(active, 'created')).toBe(SORT_GLYPH_ASC);
  });

  it('sortIndicator returns the descending glyph for the active descending column', () => {
    expect(sortIndicator({ key: 'created', dir: 'desc' }, 'created')).toBe(SORT_GLYPH_DESC);
  });
});

describe('buildPlayersListQuery', () => {
  it('buildPlayersListQuery emits sort and dir for the default state', () => {
    expect(buildPlayersListQuery(DEFAULT_SORT_STATE, false)).toBe('sort=last_seen&dir=desc');
  });

  it('buildPlayersListQuery appends filter=new when the new-players toggle is on', () => {
    expect(buildPlayersListQuery({ key: 'nickname', dir: 'asc' }, true)).toBe(
      'sort=nickname&dir=asc&filter=new',
    );
  });

  it('buildPlayersListQuery omits filter when the new-players toggle is off', () => {
    expect(buildPlayersListQuery({ key: 'nickname', dir: 'asc' }, false)).toBe(
      'sort=nickname&dir=asc',
    );
  });
});
