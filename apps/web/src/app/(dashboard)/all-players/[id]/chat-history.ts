import { dateInputToIso } from '@/lib/format';
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
  { value: 'log', label: 'Игра (лог)' },
  { value: 'rcon', label: 'Игра (RCON)' },
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
  /**
   * Archive rows use the numeric `chat_messages.id`; a live row not yet
   * reflected in the archive uses a synthetic `live:<uuid>` string key
   * instead (see `liveToChatMsg`) — the live-bus frame's own id is a uuidv7,
   * never the archive row's bigserial id.
   */
  id: number | string;
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

/** Narrows a decoded chat-messages page; `null` on any shape mismatch. */
export function parseChatPage(json: unknown): ChatPage | null {
  if (!json || typeof json !== 'object') return null;
  const value = json as Record<string, unknown>;
  if (!Array.isArray(value.items)) return null;
  const cursor = value.next_cursor;
  if (cursor !== null && typeof cursor !== 'string') return null;
  return { items: value.items as ChatMsg[], next_cursor: cursor };
}

/** Extracts the numeric count from a chat-count body; `null` on mismatch. */
export function parseChatCount(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const count = (json as Record<string, unknown>).count;
  return typeof count === 'number' ? count : null;
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
  const seen = new Set<number | string>();
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
  // The live-bus frame's id is a uuidv7 (packages/chat-ingest/src/store.ts),
  // never the archive row's numeric id — deriving a number from it always
  // produced NaN, silently dropping every live message (#432, #470). A
  // `live:`-prefixed string key is unique and never collides with an
  // archive id, and the next full reload (which replaces the whole list)
  // naturally drops it in favor of the real archived row.
  return {
    id: `live:${event.id}`,
    serverId: event.server_id,
    scope: CHANNEL_TO_SCOPE[event.channel],
    message: event.message,
    source: event.source,
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
