'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, LiveEvent } from '@/lib/live-bus';
import { useLiveBusState, useLiveSubscription } from '@/lib/use-live-bus';
import { appendChatMessage, channelMeta, formatChatTime, playerHref } from './chat-log';

export function ChatPanel({ serverId }: { serverId: string }) {
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
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Чат сервера</h2>
        <span
          className="inline-flex items-center gap-1.5 text-[10px] text-neutral-400"
          title={connected ? 'Поток чата активен' : 'Нет связи с сервером событий'}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              connected ? 'bg-green-500 animate-pulse' : 'bg-neutral-600'
            }`}
          />
          <span>{connected ? 'в эфире' : 'нет связи'}</span>
        </span>
      </header>
      <div ref={listRef} className="max-h-96 overflow-y-auto px-4 py-3">
        <ChatMessageList messages={messages} />
      </div>
    </section>
  );
}

export function ChatMessageList({ messages }: { messages: ChatMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-neutral-500">
        Сообщения появятся, когда игроки начнут писать в чат (доступно при работающем сервере).
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {messages.map((message) => (
        <ChatRow key={message.id} message={message} />
      ))}
    </ul>
  );
}

function ChatRow({ message }: { message: ChatMessage }) {
  const meta = channelMeta(message.channel);
  const href = playerHref(message);
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className="w-16 shrink-0 font-mono text-[11px] text-neutral-600">
        {formatChatTime(message.ts)}
      </span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeClass}`}
        title={message.channel}
      >
        {meta.label}
      </span>
      {href ? (
        <Link href={href} className="shrink-0 font-medium text-sky-400 hover:text-sky-300">
          {message.player_name}
        </Link>
      ) : (
        <span className="shrink-0 font-medium text-neutral-300">{message.player_name}</span>
      )}
      <span className="break-words text-neutral-200">{message.message}</span>
    </li>
  );
}
