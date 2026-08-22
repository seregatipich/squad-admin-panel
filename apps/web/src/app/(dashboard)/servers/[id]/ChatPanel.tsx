'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BanNickButton } from '@/components/BannedNameRuleModal';
import { Badge, Card, CardHeader, EmptyState, StatusDot } from '@/components/ui';
import type { ChatMessage, LiveEvent } from '@/lib/live-bus';
import { useLiveBusState, useLiveSubscription } from '@/lib/use-live-bus';
import { appendChatMessage, channelMeta, formatChatTime, playerHref } from './chat-log';

export function ChatPanel({
  serverId,
  canBan = false,
}: {
  serverId: string;
  /** Shows a «Забанить ник» button per message author. Hidden without the 'ban' squad permission. */
  canBan?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const state = useLiveBusState();
  const listRef = useRef<HTMLDivElement>(null);

  const onChat = useCallback(
    (event: Extract<LiveEvent, { type: 'chat.message' }>) => {
      setMessages((prev) => appendChatMessage(prev, event.data, { serverId }));
    },
    [serverId],
  );
  useLiveSubscription('chat.message', onChat);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows message count
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const connected = state === 'open';

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Чат сервера"
        actions={
          // Пульсация означает ровно одно: сообщения идут прямо сейчас (§9).
          <StatusDot
            state={connected ? 'good' : 'idle'}
            label={connected ? 'в эфире' : 'нет связи'}
            size="sm"
            pulse={connected}
          />
        }
      />
      <div ref={listRef} className="max-h-96 overflow-y-auto px-4 py-3">
        <ChatMessageList messages={messages} canBan={canBan} />
      </div>
    </Card>
  );
}

export function ChatMessageList({
  messages,
  canBan = false,
}: {
  messages: ChatMessage[];
  canBan?: boolean;
}) {
  if (messages.length === 0) {
    return (
      <EmptyState
        variant="initial"
        title="Сообщения появятся, когда игроки начнут писать"
        description="Чат читается при работающем сервере и подключённом RCON."
      />
    );
  }
  return (
    <ul className="space-y-1.5">
      {messages.map((message) => (
        <ChatRow key={message.id} message={message} canBan={canBan} />
      ))}
    </ul>
  );
}

function ChatRow({ message, canBan }: { message: ChatMessage; canBan: boolean }) {
  const meta = channelMeta(message.channel);
  const href = playerHref(message);
  return (
    <li className="flex items-baseline gap-2 text-[13px]">
      <span className="w-16 shrink-0 font-mono text-2xs text-ink-3">
        {formatChatTime(message.ts)}
      </span>
      <span className="shrink-0">
        <Badge tone={meta.tone} size="sm" title={message.channel}>
          {meta.label}
        </Badge>
      </span>
      {href ? (
        <Link href={href} className="shrink-0 font-medium text-accent">
          {message.player_name}
        </Link>
      ) : (
        <span className="shrink-0 font-medium text-ink">{message.player_name}</span>
      )}
      <span className="break-words text-ink-2">{message.message}</span>
      <BanNickButton
        nick={message.player_name}
        canBan={canBan}
        className="ml-auto h-6 shrink-0 rounded-ctl px-1.5 text-2xs text-ink-3 transition-colors hover:bg-crit/15 hover:text-crit"
      />
    </li>
  );
}
