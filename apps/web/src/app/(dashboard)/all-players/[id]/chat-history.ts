import type { ChatMessage as LiveChatMessage } from '@/lib/live-bus';

export const CHAT_SCOPE_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: 'team', label: 'Команда' },
  { value: 'squad', label: 'Отряд' },
  { value: 'admin', label: 'Админ' },
  { value: 'broadcast', label: 'Броадкаст' },
  { value: 'direct', label: 'Личка' },
] as const;

export type ChatScope = (typeof CHAT_SCOPE_OPTIONS)[number]['value'];

export const CHAT_SOURCE_OPTIONS = [
  { value: 'log', label: 'Игра' },
  { value: 'panel', label: 'Панель' },
] as const;

const SCOPE_LABELS = new Map(CHAT_SCOPE_OPTIONS.map((option) => [option.value, option.label]));
const SOURCE_LABELS = new Map(CHAT_SOURCE_OPTIONS.map((option) => [option.value, option.label]));

const CHANNEL_TO_SCOPE: Record<LiveChatMessage['channel'], ChatScope> = {
  ChatAll: 'all',
  ChatTeam: 'team',
  ChatSquad: 'squad',
  ChatAdmin: 'admin',
};

const PAGE_SIZE = 50;
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

export interface ChatFilters {
  serverId: string;
  scope: string;
  source: string;
  text: string;
  from: string;
  to: string;
}

export const EMPTY_CHAT_FILTERS: ChatFilters = {
  serverId: '',
  scope: '',
  source: '',
  text: '',
  from: '',
  to: '',
};

export interface ChatMsg {
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

export interface ChatPage {
  items: ChatMsg[];
  next_cursor: string | null;
}

export function dateInputToIso(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const parsed = new Date(`${value}${suffix}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function buildChatQuery(
  playerId: string,
  filters: ChatFilters,
  cursor?: string | null,
  limit: number = PAGE_SIZE,
): string {
  const params = new URLSearchParams();
  params.set('playerId', playerId);
  if (filters.serverId) params.set('serverId', filters.serverId);
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.source) params.set('source', filters.source);
  const text = filters.text.trim();
  if (text) params.set('text', text);
  const fromIso = dateInputToIso(filters.from, false);
  if (fromIso) params.set('from', fromIso);
  const toIso = dateInputToIso(filters.to, true);
  if (toIso) params.set('to', toIso);
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return `?${params.toString()}`;
}

export function thirtyDayCountQuery(playerId: string, now: number = Date.now()): string {
  const params = new URLSearchParams();
  params.set('playerId', playerId);
  params.set('from', new Date(now - THIRTY_DAYS_MS).toISOString());
  return `?${params.toString()}`;
}

export function mergeChatPage(prev: ChatMsg[], incoming: ChatMsg[], append: boolean): ChatMsg[] {
  const seen = new Set<number>();
  const base = append ? prev : [];
  for (const message of base) seen.add(message.id);
  const merged = append ? [...prev] : [];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

export function prependLiveMessage(prev: ChatMsg[], incoming: ChatMsg): ChatMsg[] {
  if (prev.some((message) => message.id === incoming.id)) return prev;
  return [incoming, ...prev];
}

export function liveToChatMsg(event: LiveChatMessage): ChatMsg | null {
  if (!event.player_id) return null;
  const numericId = Number(event.id);
  if (!Number.isFinite(numericId)) return null;
  return {
    id: numericId,
    serverId: event.server_id,
    scope: CHANNEL_TO_SCOPE[event.channel],
    message: event.message,
    source: 'log',
    isFlagged: false,
    teamId: null,
    squadId: null,
    sentAt: event.ts,
    player: { id: event.player_id, nickname: event.player_name },
  };
}

export function matchesFilters(message: ChatMsg, filters: ChatFilters): boolean {
  if (filters.serverId && message.serverId !== filters.serverId) return false;
  if (filters.scope && message.scope !== filters.scope) return false;
  if (filters.source && message.source !== filters.source) return false;
  const text = filters.text.trim().toLowerCase();
  if (text && !message.message.toLowerCase().includes(text)) return false;
  const fromIso = dateInputToIso(filters.from, false);
  if (fromIso && message.sentAt < fromIso) return false;
  const toIso = dateInputToIso(filters.to, true);
  if (toIso && message.sentAt > toIso) return false;
  return true;
}

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS.get(scope as ChatScope) ?? scope;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS.get(source as (typeof CHAT_SOURCE_OPTIONS)[number]['value']) ?? source;
}

export function formatChatTs(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
