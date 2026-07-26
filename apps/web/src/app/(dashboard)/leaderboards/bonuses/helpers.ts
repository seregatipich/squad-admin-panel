/**
 * URL state and row mapping for the bonus leaderboard page (ECON-5 #165).
 * The page has a single URL parameter — `period` — and always requests the
 * top {@link BONUS_LIMIT} rows.
 */

export type BonusPeriod = 'all' | '30d';

export const BONUS_LIMIT = 100;

export interface BonusLeaderboardRow {
  rank: number;
  player_id: string;
  current_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  value: number;
  online_seconds: number;
}

export interface BonusLeaderboardBody {
  period: string;
  available: boolean;
  economy_enabled: boolean;
  total_rows: number;
  rows: BonusLeaderboardRow[];
}

export const BONUS_PERIODS: Array<{ value: BonusPeriod; label: string }> = [
  { value: 'all', label: 'Всё время' },
  { value: '30d', label: '30 дней' },
];

interface ParamsLike {
  get(key: string): string | null;
}

/** Parses the `period` URL parameter, defaulting to the all-time balance. */
export function parsePeriod(params: ParamsLike): BonusPeriod {
  return params.get('period') === '30d' ? '30d' : 'all';
}

/** Query string for the page URL — empty for the default period. */
export function buildQueryString(period: BonusPeriod): string {
  return period === '30d' ? 'period=30d' : '';
}

/** Query string for `GET /api/v1/leaderboards/bonuses`. */
export function buildApiQuery(period: BonusPeriod, limit: number = BONUS_LIMIT): string {
  const params = new URLSearchParams();
  params.set('period', period);
  params.set('limit', String(limit));
  return params.toString();
}

/** Header label of the value column for the active period. */
export function valueColumnLabel(period: BonusPeriod): string {
  return period === '30d' ? 'Начислено за 30 дней' : 'Баланс';
}

/** Player-card target for a leaderboard row. */
export function playerHref(row: Pick<BonusLeaderboardRow, 'player_id'>): string {
  return `/players/${row.player_id}`;
}
