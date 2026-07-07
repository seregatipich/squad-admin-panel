export const TEAMKILL_SORTS = ['tk_7d', 'tk_30d', 'total'] as const;
export type TeamkillSort = (typeof TEAMKILL_SORTS)[number];
export type TeamkillOrder = 'asc' | 'desc';

export interface TeamkillFilters {
  serverId: string;
  sort: TeamkillSort;
  order: TeamkillOrder;
}

export interface TeamkillSummaryRow {
  player_id: string;
  current_name: string | null;
  steam_id64: string | null;
  eos_id: string | null;
  tk_total: number;
  tk_7d: number;
  tk_30d: number;
  victim_of_tk_total: number;
  last_tk_at: string | null;
}

export interface TeamkillSummaryResponse {
  generated_at: string;
  rows: TeamkillSummaryRow[];
}

export interface TeamkillPlayerEvent {
  id: number;
  server_id: string;
  match_id: number | null;
  weapon: string | null;
  occurred_at: string | null;
  role: 'attacker' | 'victim';
  attacker: { player_id: string; current_name: string | null } | null;
  victim: { player_id: string; current_name: string | null } | null;
}

export interface TeamkillPlayerResponse {
  stats: TeamkillSummaryRow;
  recent: TeamkillPlayerEvent[];
}

const SORT_LABELS: Record<TeamkillSort, string> = {
  tk_7d: '7 дней',
  tk_30d: '30 дней',
  total: 'Всего',
};

const SORT_SET = new Set<TeamkillSort>(TEAMKILL_SORTS);
const orderSet = new Set<TeamkillOrder>(['asc', 'desc']);
const countFmt = new Intl.NumberFormat('ru-RU');

interface ParamsLike {
  get(key: string): string | null;
}

function isSort(value: string | null): value is TeamkillSort {
  return value !== null && SORT_SET.has(value as TeamkillSort);
}

function isOrder(value: string | null): value is TeamkillOrder {
  return value !== null && orderSet.has(value as TeamkillOrder);
}

export function parseTeamkillFilters(params: ParamsLike): TeamkillFilters {
  const sort = params.get('sort');
  const order = params.get('order');
  return {
    serverId: params.get('server') || 'all',
    sort: isSort(sort) ? sort : 'tk_7d',
    order: isOrder(order) ? order : 'desc',
  };
}

export function buildTeamkillQueryString(filters: TeamkillFilters): string {
  const params = new URLSearchParams();
  if (filters.serverId !== 'all') params.set('server', filters.serverId);
  if (filters.sort !== 'tk_7d') params.set('sort', filters.sort);
  if (filters.order !== 'desc') params.set('order', filters.order);
  return params.toString();
}

export function buildTeamkillSummaryApiQuery(filters: TeamkillFilters, limit = 50): string {
  const params = new URLSearchParams();
  params.set('sort', filters.sort);
  params.set('order', filters.order);
  params.set('limit', String(limit));
  if (filters.serverId !== 'all') params.set('serverId', filters.serverId);
  return params.toString();
}

export function buildPlayerTeamkillApiPath(playerId: string, serverId = 'all'): string {
  const params = new URLSearchParams();
  if (serverId !== 'all') params.set('serverId', serverId);
  const qs = params.toString();
  return `/api/v1/players/${playerId}/teamkills${qs ? `?${qs}` : ''}`;
}

export function buildCombatLogTeamkillHref({
  role,
  playerId,
}: {
  role: 'attacker' | 'victim';
  playerId: string;
}): string {
  const params = new URLSearchParams({ facet: 'teamkills' });
  params.set(role === 'attacker' ? 'attackerPlayerId' : 'victimPlayerId', playerId);
  return `/combat-log?${params.toString()}`;
}

export function teamkillSortLabel(sort: TeamkillSort): string {
  return SORT_LABELS[sort];
}

export function formatTeamkillCount(value: number): string {
  return countFmt.format(value);
}

export function formatTeamkillDate(value: string | null): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
