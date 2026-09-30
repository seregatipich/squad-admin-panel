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
 * Players per page of the list; equals the server's default `limit` for
 * `GET /api/v1/players`, so the first page needs no paging params.
 */
export const PLAYERS_PAGE_SIZE = 200;

/**
 * Builds the `GET /api/v1/players` querystring for the current sort, filter
 * and page.
 *
 * The server caps the result at 200 rows and searches nickname (including
 * name history), SteamID64 and EOS ID — sending `q` here is what makes that
 * search actually run server-side, instead of the page re-filtering only the
 * 200 rows it happened to fetch and missing every player beyond that page
 * (#485).
 *
 * @param state - The sort to request from the server.
 * @param onlyNew - When true, appends `filter=new` (players first seen in the last 7 days).
 * @param page - 1-based page number; pages after the first append `limit` and `offset`.
 * @param q - Free-text search; sent only when it is 1–64 characters after trimming,
 *   matching the API's `q` validation.
 * @returns The encoded querystring, always `sort` then `dir`, then optional `filter`/`q`,
 *   then `limit`/`offset` for pages after the first.
 */
export function buildPlayersListQuery(
  state: PlayerSortState,
  onlyNew: boolean,
  page = 1,
  q = '',
): string {
  const params = new URLSearchParams();
  params.set('sort', state.key);
  params.set('dir', state.dir);
  if (onlyNew) params.set('filter', 'new');
  if (page > 1) {
    params.set('limit', String(PLAYERS_PAGE_SIZE));
    params.set('offset', String((page - 1) * PLAYERS_PAGE_SIZE));
  }
  const trimmed = q.trim();
  if (trimmed.length > 0 && trimmed.length <= 64) params.set('q', trimmed);
  return params.toString();
}
