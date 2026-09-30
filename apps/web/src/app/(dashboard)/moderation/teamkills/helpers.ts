import {
  isArrayOf,
  isFiniteNumber,
  isNullableNumber,
  isNullableString,
  isRecord,
} from '@/lib/json-guards';
import { moderationActionLabel } from '@/lib/moderation-actions';

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
  moderation_total: number;
  last_moderation_at: string | null;
  last_moderation_type: string | null;
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

const SUMMARY_COUNT_FIELDS = [
  'tk_total',
  'tk_7d',
  'tk_30d',
  'victim_of_tk_total',
  'moderation_total',
] as const;
const SUMMARY_NULLABLE_FIELDS = [
  'current_name',
  'steam_id64',
  'eos_id',
  'last_tk_at',
  'last_moderation_at',
  'last_moderation_type',
] as const;

function isSummaryRow(value: unknown): value is TeamkillSummaryRow {
  return (
    isRecord(value) &&
    typeof value.player_id === 'string' &&
    SUMMARY_COUNT_FIELDS.every((field) => isFiniteNumber(value[field])) &&
    SUMMARY_NULLABLE_FIELDS.every((field) => isNullableString(value[field]))
  );
}

function isEventPlayer(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) && typeof value.player_id === 'string' && isNullableString(value.current_name))
  );
}

function isPlayerEvent(value: unknown): value is TeamkillPlayerEvent {
  return (
    isRecord(value) &&
    isFiniteNumber(value.id) &&
    typeof value.server_id === 'string' &&
    isNullableNumber(value.match_id) &&
    isNullableString(value.weapon) &&
    isNullableString(value.occurred_at) &&
    (value.role === 'attacker' || value.role === 'victim') &&
    isEventPlayer(value.attacker) &&
    isEventPlayer(value.victim)
  );
}

/**
 * Validates a decoded `GET /api/v1/players/:id/teamkills` body, returning
 * `null` on any shape mismatch so the card shows an error instead of
 * crashing on a drifted field (#456).
 */
export function parseTeamkillPlayerResponse(json: unknown): TeamkillPlayerResponse | null {
  if (!isRecord(json)) return null;
  if (!isSummaryRow(json.stats) || !isArrayOf(json.recent, isPlayerEvent)) return null;
  return { stats: json.stats, recent: json.recent };
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

/** `GET /api/v1/moderation/teamkills` has no pagination yet — this is the whole page. */
export const TEAMKILL_SUMMARY_LIMIT = 50;

export function buildTeamkillSummaryApiQuery(
  filters: TeamkillFilters,
  limit = TEAMKILL_SUMMARY_LIMIT,
): string {
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
  return `/api/v1/players/${encodeURIComponent(playerId)}/teamkills${qs ? `?${qs}` : ''}`;
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
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ModerationStats {
  moderation_total: number;
  last_moderation_at: string | null;
  last_moderation_type: string | null;
}

/**
 * The latest non-reverted moderation action as «Тип · дата», with the action
 * type translated through {@link moderationActionLabel} so no machine code
 * reaches the Russian-only UI (#455).
 */
export function formatLastModeration(row: ModerationStats): string {
  const type = row.last_moderation_type ? moderationActionLabel(row.last_moderation_type) : '—';
  return `${type} · ${formatTeamkillDate(row.last_moderation_at)}`;
}

/**
 * Formats the read-only moderation-history summary shown next to a teamkill
 * offender: the latest non-reverted action type/date plus the total count.
 * Returns "—" when the player has no moderation_actions on record.
 */
export function formatModerationSummary(row: ModerationStats): string {
  if (row.moderation_total === 0) return '—';
  return `${formatLastModeration(row)}, всего ${formatTeamkillCount(row.moderation_total)}`;
}
