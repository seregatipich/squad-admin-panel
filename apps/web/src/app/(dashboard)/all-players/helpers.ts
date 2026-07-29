export const PLAYER_SORT_KEYS = ['nickname', 'last_seen', 'created', 'total_time'] as const;
export type PlayerSortKey = (typeof PLAYER_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface PlayerSortState {
  key: PlayerSortKey;
  dir: SortDir;
}

/** Server default: the ordering `GET /api/v1/players` applies with no params. */
export const DEFAULT_SORT_STATE: PlayerSortState = { key: 'last_seen', dir: 'desc' };

/** First-click direction per column: names read best A-to-Z, magnitudes best-first. */
export const COLUMN_DEFAULT_DIR: Record<PlayerSortKey, SortDir> = {
  nickname: 'asc',
  last_seen: 'desc',
  created: 'desc',
  total_time: 'desc',
};

export const SORT_GLYPH_INACTIVE = '↕';
export const SORT_GLYPH_ASC = '↑';
export const SORT_GLYPH_DESC = '↓';

/**
 * Clicking the active column flips its direction; any other column starts at
 * its default. Two-state on purpose: the server always applies an `ORDER BY`,
 * so there is no "unsorted" state to cycle back to.
 *
 * @param current - The sort currently applied to the list.
 * @param clicked - The column whose header was clicked.
 * @returns The sort state to apply next.
 */
export function nextSortState(current: PlayerSortState, clicked: PlayerSortKey): PlayerSortState {
  if (current.key === clicked) {
    return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key: clicked, dir: COLUMN_DEFAULT_DIR[clicked] };
}

/**
 * The glyph for one header: the neutral one unless `column` is the active sort.
 *
 * @param current - The sort currently applied to the list.
 * @param column - The column whose header is being rendered.
 * @returns One of {@link SORT_GLYPH_INACTIVE}, {@link SORT_GLYPH_ASC}, {@link SORT_GLYPH_DESC}.
 */
export function sortIndicator(current: PlayerSortState, column: PlayerSortKey): string {
  if (current.key !== column) return SORT_GLYPH_INACTIVE;
  return current.dir === 'asc' ? SORT_GLYPH_ASC : SORT_GLYPH_DESC;
}

/**
 * Querystring for `GET /api/v1/players`, without the leading `?`.
 *
 * @param state - The sort to request from the server.
 * @param onlyNew - When true, appends `filter=new` (players first seen in the last 7 days).
 * @returns The encoded querystring, always `sort` then `dir`, then optional `filter`.
 */
export function buildPlayersListQuery(state: PlayerSortState, onlyNew: boolean): string {
  const params = new URLSearchParams();
  params.set('sort', state.key);
  params.set('dir', state.dir);
  if (onlyNew) params.set('filter', 'new');
  return params.toString();
}
