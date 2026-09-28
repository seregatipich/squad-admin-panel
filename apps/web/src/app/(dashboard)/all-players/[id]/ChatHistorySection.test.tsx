// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@/lib/live-bus';

type LiveHandler = (event: Extract<LiveEvent, { type: 'chat.message' }>) => void;
let liveHandlers: Partial<Record<string, LiveHandler>> = {};

vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn((type: string, handler: LiveHandler) => {
    liveHandlers[type] = handler;
  }),
}));

import { ChatHistorySection } from './ChatHistorySection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const PLAYER_ID = 'b1e2c3d4-0000-0000-0000-000000000001';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  liveHandlers = {};
});

describe('ChatHistorySection — race between loadMore() and a filter-driven load() (#433)', () => {
  it('ignores a stale loadMore() response that resolves after a newer filter load()', async () => {
    const firstPage = {
      items: [
        {
          id: 1,
          serverId: 'srv-1',
          scope: 'all',
          message: 'initial message',
          source: 'log',
          isFlagged: false,
          teamId: null,
          squadId: null,
          sentAt: '2026-07-01T10:00:00.000Z',
          player: { id: PLAYER_ID, nickname: 'Alpha' },
        },
      ],
      next_cursor: 'CURSOR_1',
    };
    const filteredPage = {
      items: [
        {
          id: 2,
          serverId: 'srv-1',
          scope: 'admin',
          message: 'admin channel message',
          source: 'log',
          isFlagged: false,
          teamId: null,
          squadId: null,
          sentAt: '2026-07-01T11:00:00.000Z',
          player: { id: PLAYER_ID, nickname: 'Alpha' },
        },
      ],
      next_cursor: null,
    };
    const countResponse = { count: 5 };

    let listCalls = 0;
    const staleLoadMore = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/v1/chat/messages/count')) {
        return Promise.resolve(new Response(JSON.stringify(countResponse), { status: 200 }));
      }
      if (url.startsWith('/api/v1/chat/messages')) {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve(new Response(JSON.stringify(firstPage), { status: 200 }));
        }
        if (listCalls === 2) {
          // loadMore(): held back deliberately to simulate it resolving late.
          return staleLoadMore.promise;
        }
        return Promise.resolve(new Response(JSON.stringify(filteredPage), { status: 200 }));
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatHistorySection playerId={PLAYER_ID} />);
    await screen.findByText('initial message');

    fireEvent.click(screen.getByRole('button', { name: /показать ещё/i }));
    await vi.waitFor(() => expect(listCalls).toBe(2));

    // Apply a new filter while loadMore() is still in flight.
    fireEvent.click(screen.getByRole('button', { name: /применить/i }));
    await screen.findByText('admin channel message');
    expect(screen.queryByText('initial message')).not.toBeInTheDocument();

    // Now the stale loadMore() response finally arrives.
    staleLoadMore.resolve(
      new Response(
        JSON.stringify({ items: [{ ...firstPage.items[0], id: 99 }], next_cursor: 'STALE' }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    // It must not have clobbered the newer filter's result.
    expect(screen.queryByText('initial message')).not.toBeInTheDocument();
    expect(screen.getByText('admin channel message')).toBeInTheDocument();
  });
});

describe('ChatHistorySection — live chat.message events (#432, #470)', () => {
  it('renders a live message with a real uuidv7 frame id and its actual source', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/v1/chat/messages/count')) {
        return Promise.resolve(new Response(JSON.stringify({ count: 0 }), { status: 200 }));
      }
      if (url.startsWith('/api/v1/chat/messages')) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }),
        );
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatHistorySection playerId={PLAYER_ID} />);
    await screen.findByText('Сообщений нет');

    liveHandlers['chat.message']?.({
      type: 'chat.message',
      ts: '2026-07-01T12:00:00.000Z',
      data: {
        id: '0192c1e4-9b2a-7c31-8f2e-5a1d3b6e7c90',
        server_id: 'srv-1',
        ts: '2026-07-01T12:00:00.000Z',
        channel: 'ChatAll',
        player_id: PLAYER_ID,
        player_name: 'Alpha',
        steam_id64: null,
        eos_id: null,
        message: 'live update',
        source: 'rcon',
      },
    });

    const messageCell = await screen.findByText('live update');
    const row = messageCell.closest('tr');
    expect(row).not.toBeNull();
    expect(row && within(row).getByText('Игра (RCON)')).toBeInTheDocument();
  });
});
