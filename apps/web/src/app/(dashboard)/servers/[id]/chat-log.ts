import type { ChatChannel, ChatMessage } from '@/lib/live-bus';

export const CHAT_LOG_CAP = 200;

export function appendChatMessage(
  current: ChatMessage[],
  incoming: ChatMessage,
  options: { serverId: string; cap?: number },
): ChatMessage[] {
  if (incoming.server_id !== options.serverId) return current;
  if (current.some((message) => message.id === incoming.id)) return current;
  const cap = options.cap ?? CHAT_LOG_CAP;
  const next = [...current, incoming];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

interface ChannelMeta {
  label: string;
  badgeClass: string;
}

const CHANNEL_META: Record<ChatChannel, ChannelMeta> = {
  ChatAll: { label: 'Все', badgeClass: 'bg-sky-900 text-sky-200' },
  ChatTeam: { label: 'Команда', badgeClass: 'bg-emerald-900 text-emerald-200' },
  ChatSquad: { label: 'Отряд', badgeClass: 'bg-amber-900 text-amber-200' },
  ChatAdmin: { label: 'Админ', badgeClass: 'bg-red-900 text-red-200' },
};

export function channelMeta(channel: ChatChannel): ChannelMeta {
  return CHANNEL_META[channel] ?? { label: channel, badgeClass: 'bg-neutral-800 text-neutral-300' };
}

export function playerHref(message: ChatMessage): string | null {
  if (message.player_id) return `/all-players/${message.player_id}`;
  if (message.steam_id64) return `/all-players?q=${message.steam_id64}`;
  return null;
}

export function formatChatTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return '--:--:--';
  return parsed.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
