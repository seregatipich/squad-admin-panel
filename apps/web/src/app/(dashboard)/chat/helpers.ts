import type { ChatChannel, ChatMessage } from '@/lib/live-bus';

export const CHAT_SCOPES = ['all', 'team', 'squad', 'admin', 'broadcast', 'direct'] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

export const PAGE_LIMIT = 100;
export const LIVE_CAP = 200;

export interface ScopeMeta {
  labelRu: string;
  labelEn: string;
  icon: string;
  badgeClass: string;
}

export const SCOPE_META: Record<ChatScope, ScopeMeta> = {
  all: { labelRu: 'Все', labelEn: 'All', icon: '🌐', badgeClass: 'bg-sky-900 text-sky-200' },
  team: {
    labelRu: 'Команда',
    labelEn: 'Team',
    icon: '👥',
    badgeClass: 'bg-emerald-900 text-emerald-200',
  },
  squad: {
    labelRu: 'Отряд',
    labelEn: 'Squad',
    icon: '🛡️',
    badgeClass: 'bg-amber-900 text-amber-200',
  },
  admin: { labelRu: 'Админ', labelEn: 'Admin', icon: '🛠️', badgeClass: 'bg-red-900 text-red-200' },
  broadcast: {
    labelRu: 'Бродкаст',
    labelEn: 'Broadcast',
    icon: '📢',
    badgeClass: 'bg-purple-900 text-purple-200',
  },
  direct: {
    labelRu: 'Личное',
    labelEn: 'Direct',
    icon: '✉️',
    badgeClass: 'bg-fuchsia-900 text-fuchsia-200',
  },
};

const FALLBACK_SCOPE_META: ScopeMeta = {
  labelRu: 'Прочее',
  labelEn: 'Other',
  icon: '💬',
  badgeClass: 'bg-neutral-800 text-neutral-300',
};

export function isChatScope(value: string): value is ChatScope {
  return (CHAT_SCOPES as readonly string[]).includes(value);
}

export function scopeMeta(scope: string): ScopeMeta {
  return isChatScope(scope) ? SCOPE_META[scope] : FALLBACK_SCOPE_META;
}

const CHANNEL_SCOPE: Record<ChatChannel, ChatScope> = {
  ChatAll: 'all',
  ChatTeam: 'team',
  ChatSquad: 'squad',
  ChatAdmin: 'admin',
};

export function channelToScope(channel: ChatChannel): ChatScope {
  return CHANNEL_SCOPE[channel] ?? 'all';
}

export interface ChatFilters {
  playerQuery: string;
  text: string;
  serverIds: string[];
  scopes: ChatScope[];
  from: string;
  to: string;
  flaggedOnly: boolean;
}

export const EMPTY_FILTERS: ChatFilters = {
  playerQuery: '',
  text: '',
  serverIds: [],
  scopes: [],
  from: '',
  to: '',
  flaggedOnly: false,
};

interface ParamsLike {
  get(key: string): string | null;
  getAll(key: string): string[];
}

function normalizeDate(raw: string | null): string {
  if (!raw) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export function parseFilters(params: ParamsLike): ChatFilters {
  const scopes = params.getAll('scope').filter(isChatScope);
  const serverIds = params.getAll('server').filter((id) => id.length > 0);
  return {
    playerQuery: params.get('player')?.trim() ?? '',
    text: params.get('text')?.trim() ?? '',
    serverIds,
    scopes,
    from: normalizeDate(params.get('from')),
    to: normalizeDate(params.get('to')),
    flaggedOnly: params.get('flagged') === '1',
  };
}

export function buildQueryString(filters: ChatFilters): string {
  const params = new URLSearchParams();
  if (filters.playerQuery) params.set('player', filters.playerQuery);
  if (filters.text) params.set('text', filters.text);
  for (const serverId of filters.serverIds) params.append('server', serverId);
  for (const scope of filters.scopes) params.append('scope', scope);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.flaggedOnly) params.set('flagged', '1');
  return params.toString();
}

function dayStartIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dayEndIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function buildApiQuery(
  filters: ChatFilters,
  cursor?: string | null,
  limit: number = PAGE_LIMIT,
): string {
  const params = new URLSearchParams();
  if (filters.playerQuery) params.set('playerQuery', filters.playerQuery);
  if (filters.text) params.set('text', filters.text);
  for (const serverId of filters.serverIds) params.append('serverId', serverId);
  for (const scope of filters.scopes) params.append('scope', scope);
  const fromIso = dayStartIso(filters.from);
  if (fromIso) params.set('from', fromIso);
  const toIso = dayEndIso(filters.to);
  if (toIso) params.set('to', toIso);
  if (filters.flaggedOnly) params.set('flaggedOnly', 'true');
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function hasDateFilter(filters: ChatFilters): boolean {
  return Boolean(filters.from || filters.to);
}

export function hasActiveFilters(filters: ChatFilters): boolean {
  return (
    Boolean(filters.playerQuery) ||
    Boolean(filters.text) ||
    filters.serverIds.length > 0 ||
    filters.scopes.length > 0 ||
    Boolean(filters.from) ||
    Boolean(filters.to) ||
    filters.flaggedOnly
  );
}

export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export interface ChatApiItem {
  id: number;
  serverId: string;
  scope: string;
  message: string;
  source: string;
  isFlagged: boolean;
  teamId: number | null;
  squadId: number | null;
  sentAt: string;
  player: { id: string; nickname: string };
}

export interface ChatRow {
  key: string;
  id: string;
  playerId: string | null;
  nickname: string;
  scope: ChatScope;
  message: string;
  teamId: number | null;
  serverId: string;
  sentAt: string;
  isFlagged: boolean;
  source: string;
  live: boolean;
}

export function apiItemToRow(item: ChatApiItem): ChatRow {
  return {
    key: `db:${item.id}`,
    id: String(item.id),
    playerId: item.player.id,
    nickname: item.player.nickname,
    scope: isChatScope(item.scope) ? item.scope : 'all',
    message: item.message,
    teamId: item.teamId,
    serverId: item.serverId,
    sentAt: item.sentAt,
    isFlagged: item.isFlagged,
    source: item.source,
    live: false,
  };
}

export function liveMessageToRow(message: ChatMessage): ChatRow {
  return {
    key: `live:${message.id}`,
    id: message.id,
    playerId: message.player_id,
    nickname: message.player_name,
    scope: channelToScope(message.channel),
    message: message.message,
    teamId: null,
    serverId: message.server_id,
    sentAt: message.ts,
    isFlagged: false,
    source: 'log',
    live: true,
  };
}

export function liveRowMatchesFilters(row: ChatRow, filters: ChatFilters): boolean {
  if (filters.flaggedOnly) return false;
  if (filters.serverIds.length > 0 && !filters.serverIds.includes(row.serverId)) return false;
  if (filters.scopes.length > 0 && !filters.scopes.includes(row.scope)) return false;
  if (filters.text && !row.message.toLowerCase().includes(filters.text.toLowerCase())) return false;
  if (
    filters.playerQuery &&
    !row.nickname.toLowerCase().includes(filters.playerQuery.toLowerCase())
  )
    return false;
  return true;
}

export function prependLiveRow(
  current: ChatRow[],
  incoming: ChatRow,
  cap: number = LIVE_CAP,
): ChatRow[] {
  if (current.some((row) => row.key === incoming.key)) return current;
  const next = [incoming, ...current];
  return next.length > cap ? next.slice(0, cap) : next;
}

export function rowSignature(row: ChatRow): string {
  return `${row.serverId}|${row.sentAt}|${row.playerId ?? ''}|${row.message}`;
}

export function combineRows(liveRows: ChatRow[], pageRows: ChatRow[]): ChatRow[] {
  const liveSignatures = new Set(liveRows.map(rowSignature));
  const deduped = pageRows.filter((row) => !liveSignatures.has(rowSignature(row)));
  return [...liveRows, ...deduped];
}

export function playerHref(row: ChatRow): string | null {
  return row.playerId ? `/players/${row.playerId}` : null;
}

export function formatArchiveTime(iso: string): string {
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

export interface TeamFlagMeta {
  label: string;
  badgeClass: string;
}

export function teamFlagMeta(teamId: number | null): TeamFlagMeta | null {
  if (teamId === 1) return { label: 'К1', badgeClass: 'bg-blue-900 text-blue-200' };
  if (teamId === 2) return { label: 'К2', badgeClass: 'bg-orange-900 text-orange-200' };
  return null;
}
