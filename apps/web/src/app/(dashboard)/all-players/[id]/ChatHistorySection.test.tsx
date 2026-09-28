// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

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
