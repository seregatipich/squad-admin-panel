export const PAGE_LIMIT = 100;

export const COMBAT_FACETS = [
  'kills',
  'deaths',
  'wounds',
  'revives',
  'damage',
  'teamkills',
] as const;
export type CombatFacet = (typeof COMBAT_FACETS)[number];

export type CombatEventType = 'death' | 'damage' | 'wound' | 'revive';

export type DatePreset =
  | 'today'
  | 'yesterday'
  | '24h'
  | 'week'
  | 'month'
  | '30days'
  | '60days'
  | '90days'
  | 'all'
  | 'custom';

export type SortDir = 'asc' | 'desc';

const FACET_LABELS: Record<CombatFacet, string> = {
  kills: 'Убийства',
  deaths: 'Смерти',
  wounds: 'Ранения',
  revives: 'Реанимации',
  damage: 'Урон',
  teamkills: 'Тимкиллы',
};

export function facetLabel(facet: CombatFacet): string {
  return FACET_LABELS[facet];
}

export interface FacetApiParams {
  type?: CombatEventType[];
  teamkillsOnly?: boolean;
}

export function facetToApiParams(facet: CombatFacet): FacetApiParams {
  switch (facet) {
    case 'kills':
    case 'deaths':
      return { type: ['death'] };
    case 'wounds':
      return { type: ['wound'] };
    case 'revives':
      return { type: ['revive'] };
    case 'damage':
      return { type: ['damage'] };
    case 'teamkills':
      return { teamkillsOnly: true };
  }
}

export function showsDamageColumn(facet: CombatFacet): boolean {
  return facet === 'damage';
}

export interface EventTypeMeta {
  labelRu: string;
  badgeClass: string;
}

const EVENT_TYPE_META: Record<CombatEventType, EventTypeMeta> = {
  death: { labelRu: 'Смерть', badgeClass: 'bg-red-900 text-red-200' },
  damage: { labelRu: 'Урон', badgeClass: 'bg-amber-900 text-amber-200' },
  wound: { labelRu: 'Ранение', badgeClass: 'bg-orange-900 text-orange-200' },
  revive: { labelRu: 'Реанимация', badgeClass: 'bg-emerald-900 text-emerald-200' },
};

function isEventType(value: string): value is CombatEventType {
  return value === 'death' || value === 'damage' || value === 'wound' || value === 'revive';
}

export function eventTypeMeta(eventType: string): EventTypeMeta {
  if (isEventType(eventType)) return EVENT_TYPE_META[eventType];
  return { labelRu: eventType, badgeClass: 'bg-neutral-800 text-neutral-300' };
}

export interface CombatFilters {
  facet: CombatFacet;
  attackerQuery: string;
  attackerPlayerId: string;
  victimQuery: string;
  victimPlayerId: string;
  weapon: string;
  serverIds: string[];
  preset: DatePreset;
  from: string;
  to: string;
}

export const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '24h', label: '24ч' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: '30days', label: '30 дней' },
  { value: '60days', label: '60 дней' },
  { value: '90days', label: '90 дней' },
  { value: 'all', label: 'Всё время' },
  { value: 'custom', label: 'Произвольно' },
];

const PRESET_VALUES = new Set<DatePreset>(DATE_PRESETS.map((preset) => preset.value));

function isFacet(value: string | null): value is CombatFacet {
  return value !== null && (COMBAT_FACETS as readonly string[]).includes(value);
}

function isPreset(value: string | null): value is DatePreset {
  return value !== null && PRESET_VALUES.has(value as DatePreset);
}

interface ParamsLike {
  get(key: string): string | null;
  getAll(key: string): string[];
}

export function defaultFilters(): CombatFilters {
  return {
    facet: 'kills',
    attackerQuery: '',
    attackerPlayerId: '',
    victimQuery: '',
    victimPlayerId: '',
    weapon: '',
    serverIds: [],
    preset: 'all',
    from: '',
    to: '',
  };
}

export function parseFilters(params: ParamsLike): CombatFilters {
  const facetRaw = params.get('facet');
  const presetRaw = params.get('preset');
  return {
    facet: isFacet(facetRaw) ? facetRaw : 'kills',
    attackerQuery: params.get('attacker')?.trim() ?? '',
    attackerPlayerId: params.get('attackerPlayerId')?.trim() ?? '',
    victimQuery: params.get('victim')?.trim() ?? '',
    victimPlayerId: params.get('victimPlayerId')?.trim() ?? '',
    weapon: params.get('weapon')?.trim() ?? '',
    serverIds: params.getAll('server').filter((id) => id.length > 0),
    preset: isPreset(presetRaw) ? presetRaw : 'all',
    from: params.get('from')?.trim() ?? '',
    to: params.get('to')?.trim() ?? '',
  };
}

export function buildQueryString(filters: CombatFilters): string {
  const params = new URLSearchParams();
  if (filters.facet !== 'kills') params.set('facet', filters.facet);
  if (filters.attackerQuery) params.set('attacker', filters.attackerQuery);
  if (filters.attackerPlayerId) params.set('attackerPlayerId', filters.attackerPlayerId);
  if (filters.victimQuery) params.set('victim', filters.victimQuery);
  if (filters.victimPlayerId) params.set('victimPlayerId', filters.victimPlayerId);
  if (filters.weapon) params.set('weapon', filters.weapon);
  for (const serverId of filters.serverIds) params.append('server', serverId);
  if (filters.preset !== 'all') params.set('preset', filters.preset);
  if (filters.preset === 'custom') {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  return params.toString();
}

export function hasActiveFilters(filters: CombatFilters): boolean {
  return (
    Boolean(filters.attackerQuery) ||
    Boolean(filters.attackerPlayerId) ||
    Boolean(filters.victimQuery) ||
    Boolean(filters.victimPlayerId) ||
    Boolean(filters.weapon) ||
    filters.serverIds.length > 0 ||
    filters.preset !== 'all'
  );
}

function startOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(0, 0, 0, 0);
  return day;
}

function endOfDay(reference: Date): Date {
  const day = new Date(reference);
  day.setHours(23, 59, 59, 999);
  return day;
}

function addDays(reference: Date, amount: number): Date {
  const shifted = new Date(reference);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DateRange {
  dateFrom?: Date;
  dateTo?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveDateRange(filters: CombatFilters, now: Date = new Date()): DateRange {
  switch (filters.preset) {
    case 'today':
      return { dateFrom: startOfDay(now), dateTo: now };
    case 'yesterday': {
      const from = addDays(startOfDay(now), -1);
      return { dateFrom: from, dateTo: endOfDay(from) };
    }
    case '24h':
      return { dateFrom: new Date(now.getTime() - DAY_MS), dateTo: now };
    case 'week':
      return { dateFrom: addDays(startOfDay(now), -6), dateTo: now };
    case 'month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { dateFrom: from, dateTo: now };
    }
    case '30days':
      return { dateFrom: new Date(now.getTime() - 30 * DAY_MS), dateTo: now };
    case '60days':
      return { dateFrom: new Date(now.getTime() - 60 * DAY_MS), dateTo: now };
    case '90days':
      return { dateFrom: new Date(now.getTime() - 90 * DAY_MS), dateTo: now };
    case 'custom': {
      const range: DateRange = {};
      const from = parseDateInput(filters.from);
      const to = parseDateInput(filters.to);
      if (from) range.dateFrom = startOfDay(from);
      if (to) range.dateTo = endOfDay(to);
      return range;
    }
    default:
      return {};
  }
}

export interface ApiQueryOptions {
  now?: Date;
  cursor?: string | null;
  limit?: number;
  lockedServerId?: string;
}

function appendFilterParams(
  params: URLSearchParams,
  filters: CombatFilters,
  lockedServerId: string | undefined,
  now: Date,
): void {
  const facetParams = facetToApiParams(filters.facet);
  for (const type of facetParams.type ?? []) params.append('type', type);
  if (facetParams.teamkillsOnly) params.set('teamkillsOnly', 'true');

  if (lockedServerId) {
    params.append('serverId', lockedServerId);
  } else {
    for (const id of filters.serverIds) params.append('serverId', id);
  }

  if (filters.attackerPlayerId) {
    params.set('attackerPlayerId', filters.attackerPlayerId);
  } else if (filters.attackerQuery) {
    params.set('attackerName', filters.attackerQuery);
  }
  if (filters.victimPlayerId) {
    params.set('victimPlayerId', filters.victimPlayerId);
  } else if (filters.victimQuery) {
    params.set('victimName', filters.victimQuery);
  }
  if (filters.weapon) params.set('weapon', filters.weapon);

  const range = resolveDateRange(filters, now);
  if (range.dateFrom) params.set('from', range.dateFrom.toISOString());
  if (range.dateTo) params.set('to', range.dateTo.toISOString());
}

export function buildListApiQuery(filters: CombatFilters, options: ApiQueryOptions = {}): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, options.lockedServerId, now);
  params.set('limit', String(options.limit ?? PAGE_LIMIT));
  if (options.cursor) params.set('cursor', options.cursor);
  return params.toString();
}

export function buildExportApiQuery(filters: CombatFilters, options: ApiQueryOptions = {}): string {
  const now = options.now ?? new Date();
  const params = new URLSearchParams();
  appendFilterParams(params, filters, options.lockedServerId, now);
  params.set('format', 'csv');
  return params.toString();
}

export interface CombatPlayer {
  player_id: string;
  current_name: string | null;
}

export interface CombatApiRow {
  id: number;
  eventType: string;
  serverId: string;
  matchId: number | null;
  weapon: string | null;
  damage: string | null;
  attackerKit: string | null;
  isTeamkill: boolean;
  occurredAt: string;
  attacker: CombatPlayer | null;
  victim: CombatPlayer | null;
}

export interface CombatListResponse {
  rows: CombatApiRow[];
  nextCursor: string | null;
  approxTotal: number;
}

export function playerHref(player: CombatPlayer | null): string | null {
  if (!player || !player.player_id) return null;
  return `/all-players/${player.player_id}`;
}

export function playerLabel(player: CombatPlayer | null): string {
  if (!player) return '—';
  return player.current_name ?? player.player_id.slice(0, 8);
}

export function formatDamage(damage: string | null): string {
  if (damage === null) return '—';
  const value = Number(damage);
  if (Number.isNaN(value)) return damage;
  return String(Number(value.toFixed(2)));
}

export function formatEventTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function sortRowsByDamage(rows: CombatApiRow[], dir: SortDir): CombatApiRow[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftDamage = left.damage === null ? null : Number(left.damage);
    const rightDamage = right.damage === null ? null : Number(right.damage);
    if (leftDamage === null && rightDamage === null) return 0;
    if (leftDamage === null) return 1;
    if (rightDamage === null) return -1;
    return (leftDamage - rightDamage) * factor;
  });
}

export function appendPage(existing: CombatApiRow[], incoming: CombatApiRow[]): CombatApiRow[] {
  const seen = new Set(existing.map((row) => row.id));
  const additions = incoming.filter((row) => !seen.has(row.id));
  return [...existing, ...additions];
}

export function shortServerLabel(serverNames: Map<string, string>, serverId: string): string {
  return serverNames.get(serverId) ?? `${serverId.slice(0, 8)}…`;
}

export const LIVE_CAP = 200;

export type CombatLiveEventKind =
  | 'combat_damage'
  | 'combat_wound'
  | 'combat_death'
  | 'combat_revive';

export interface CombatLiveEventData {
  server_id: string;
  match_id: string | null;
  kind: CombatLiveEventKind;
  attacker_player_id: string | null;
  victim_player_id: string | null;
  weapon: string | null;
  damage: number | null;
  is_teamkill: boolean;
  is_suicide: boolean;
  occurred_at: string;
}

const LIVE_KIND_TO_EVENT_TYPE: Record<CombatLiveEventKind, CombatEventType> = {
  combat_damage: 'damage',
  combat_wound: 'wound',
  combat_death: 'death',
  combat_revive: 'revive',
};

/**
 * Deterministic negative id for a live combat.event frame: the live bus
 * payload carries no `combat_events.id` (it is not resolved from the DB row),
 * so we derive a stable one from the event's own fields. Negative so it never
 * collides with a real (positive, bigserial) row id, and stable so the exact
 * same frame delivered twice (e.g. a duplicate publish) dedupes to one row.
 */
function liveRowId(data: CombatLiveEventData): number {
  const key = `${data.server_id}|${data.kind}|${data.occurred_at}|${data.attacker_player_id ?? ''}|${data.victim_player_id ?? ''}|${data.weapon ?? ''}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33 + key.charCodeAt(i)) | 0;
  }
  return -Math.abs(hash);
}

/**
 * Maps a `combat.event` live-bus payload to the same row shape the
 * `/api/v1/combat-events` REST endpoint returns, so live rows can be
 * prepended onto the same table the paginated history renders (COMBAT-6).
 * Player names are unavailable on the live payload (only ids), so they are
 * always `null`; the caller resolves them lazily via the player link.
 */
export function combatEventToRow(data: CombatLiveEventData): CombatApiRow {
  return {
    id: liveRowId(data),
    eventType: LIVE_KIND_TO_EVENT_TYPE[data.kind],
    serverId: data.server_id,
    matchId: null,
    weapon: data.weapon,
    damage: data.damage === null ? null : String(data.damage),
    attackerKit: null,
    isTeamkill: data.is_teamkill,
    occurredAt: data.occurred_at,
    attacker: data.attacker_player_id
      ? { player_id: data.attacker_player_id, current_name: null }
      : null,
    victim: data.victim_player_id ? { player_id: data.victim_player_id, current_name: null } : null,
  };
}

/**
 * Prepends a live combat row to the currently rendered list, deduping by id
 * and capping the list so an unattended Live view doesn't grow unbounded.
 */
export function prependLiveRow(
  current: CombatApiRow[],
  incoming: CombatApiRow,
  cap: number = LIVE_CAP,
): CombatApiRow[] {
  if (current.some((row) => row.id === incoming.id)) return current;
  const next = [incoming, ...current];
  return next.length > cap ? next.slice(0, cap) : next;
}
