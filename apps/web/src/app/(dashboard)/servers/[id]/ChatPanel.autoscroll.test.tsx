// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LiveEvent } from '@/lib/live-bus';
import { CHAT_LOG_CAP } from './chat-log';

type ChatHandler = (event: Extract<LiveEvent, { type: 'chat.message' }>) => void;

let chatHandler: ChatHandler | null = null;

vi.mock('@/lib/use-live-bus', () => ({
  useLiveBusState: () => 'open',
  useLiveSubscription: (type: string, handler: ChatHandler) => {
    if (type === 'chat.message') chatHandler = handler;
  },
}));

import { ChatPanel } from './ChatPanel';

function message(seq: number): ChatMessage {
  return {
    id: `msg-${seq}`,
    server_id: 'srv-1',
    channel: 'ChatAll',
    player_name: `Игрок${seq}`,
    player_id: null,
    steam_id64: null,
    eos_id: null,
    source: 'log',
    message: `Сообщение ${seq}`,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  };
}

afterEach(() => {
  cleanup();
  chatHandler = null;
});

describe('ChatPanel autoscroll beyond the message cap', () => {
  it(
    'keeps scrolling to the bottom after the 200-message buffer fills (#599)',
    // Alone this takes ~3 s; the 201 re-renders are CPU-bound, so on a busy machine (the pre-push
    // checklist runs the whole workspace at once) it needs a much wider budget than the default.
    { timeout: 90000 },
    () => {
      const { container } = render(<ChatPanel serverId="srv-1" />);
      const list = container.querySelector<HTMLDivElement>('.overflow-y-auto');
      if (!list) throw new Error('chat list container not found');

      // scrollHeight tracks rendered text length, mimicking a real DOM where
      // content keeps changing height (variable message length, timestamps)
      // even once the visible row count is capped at CHAT_LOG_CAP — exactly
      // the case where a `messages.length`-only dependency goes stale.
      Object.defineProperty(list, 'scrollHeight', {
        configurable: true,
        get(this: HTMLDivElement) {
          return this.textContent?.length ?? 0;
        },
      });

      // Each message arrives as its own live-bus event/commit, so each must get
      // its own `act`; batching them into one `act` would collapse the whole
      // burst into a single render and mask the bug this test guards against.
      for (let seq = 1; seq <= CHAT_LOG_CAP + 1; seq += 1) {
        act(() => {
          chatHandler?.({ type: 'chat.message', ts: new Date().toISOString(), data: message(seq) });
        });
      }

      // The buffer is capped at CHAT_LOG_CAP, so messages.length stops changing
      // once the cap is reached — the autoscroll effect must key off the last
      // message's id instead, or scrollTop would freeze at a stale value.
      expect(list.querySelectorAll('li').length).toBe(CHAT_LOG_CAP);
      expect(list.scrollTop).toBe(list.scrollHeight);
    },
  );
});
