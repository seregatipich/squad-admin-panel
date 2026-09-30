// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stableSearchParams = new URLSearchParams();
let currentSearchParams = stableSearchParams;

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  usePathname: vi.fn(() => '/chat'),
  useSearchParams: vi.fn(() => currentSearchParams),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { ChatArchive } from './ChatArchive';

const MESSAGES_RESPONSE = {
  items: [
    {
      id: 1,
      serverId: 'srv-1',
      scope: 'all',
      message: 'hello everyone',
      source: 'chat',
      isFlagged: false,
      teamId: null,
      squadId: null,
      sentAt: '2026-04-23T11:30:20.485Z',
      player: { id: 'player-1', nickname: 'Alpha' },
    },
  ],
  next_cursor: null,
};

function mockFetch(opts: { canBan: boolean }) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/chat/messages')) {
      return Promise.resolve(new Response(JSON.stringify(MESSAGES_RESPONSE), { status: 200 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url === '/api/v1/me') {
      return Promise.resolve(
        new Response(JSON.stringify({ squad_permissions: opts.canBan ? ['ban'] : [] }), {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  currentSearchParams = stableSearchParams;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ChatArchive — BANNAME-3 ban button gating + prefill', () => {
  it('hides the «Забанить ник» button without the ban squad permission', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false }));
    render(<ChatArchive />);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('button', { name: /забанить ник/i })).not.toBeInTheDocument();
  });

  it('shows a «Забанить ник» button with the ban squad permission, prefilling the modal with the row nickname', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: true }));
    render(<ChatArchive />);
    const button = await screen.findByRole('button', { name: /забанить ник/i });
    fireEvent.click(button);
    const patternInput = (await screen.findByLabelText(/паттерн/i)) as HTMLInputElement;
    expect(patternInput.value).toBe('Alpha');
  });
});

describe('ChatArchive — race between loadMore() and a filter-driven load() (#504)', () => {
  it('ignores a stale loadMore() response that resolves after a newer filter load()', async () => {
    const firstPage = {
      items: [
        {
          id: 1,
          serverId: 'srv-1',
          scope: 'all',
          message: 'page one',
          source: 'chat',
          isFlagged: false,
          teamId: null,
          squadId: null,
          sentAt: '2026-04-23T11:30:20.485Z',
          player: { id: 'player-1', nickname: 'Alpha' },
        },
      ],
      next_cursor: 'CURSOR_1',
    };
    const staleLoadMorePage = deferred<Response>();
    const newFilterPage = {
      items: [
        {
          id: 2,
          serverId: 'srv-1',
          scope: 'admin',
          message: 'new filter message',
          source: 'chat',
          isFlagged: false,
          teamId: null,
          squadId: null,
          sentAt: '2026-04-23T12:00:00.000Z',
          player: { id: 'player-2', nickname: 'Bravo' },
        },
      ],
      next_cursor: null,
    };

    let messagesCall = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/v1/chat/messages')) {
        messagesCall += 1;
        if (messagesCall === 1) {
          return Promise.resolve(new Response(JSON.stringify(firstPage), { status: 200 }));
        }
        if (messagesCall === 2) {
          // The «Показать ещё» request: resolves only after we force it, later.
          return staleLoadMorePage.promise;
        }
        return Promise.resolve(new Response(JSON.stringify(newFilterPage), { status: 200 }));
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ squad_permissions: [] }), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    currentSearchParams = new URLSearchParams();
    const { rerender } = render(<ChatArchive />);
    await screen.findByText('Alpha');

    // Start "Показать ещё" — its response will be held back deliberately.
    fireEvent.click(screen.getByRole('button', { name: /показать ещё/i }));
    await vi.waitFor(() => expect(messagesCall).toBe(2));

    // While that request is in flight, the operator changes the filter.
    currentSearchParams = new URLSearchParams({ scope: 'admin' });
    rerender(<ChatArchive />);
    await screen.findByText('new filter message');
    expect(screen.queryByText('page one')).not.toBeInTheDocument();

    // Now the stale loadMore() response finally arrives.
    staleLoadMorePage.resolve(
      new Response(
        JSON.stringify({ items: [{ ...firstPage.items[0], id: 99 }], next_cursor: 'STALE' }),
        { status: 200 },
      ),
    );
    // Give the stale response's promise chain and any resulting state update
    // every chance to land before asserting it did not.
    await new Promise((r) => setTimeout(r, 20));

    // It must not have clobbered the newer filter's result.
    expect(screen.queryByText('page one')).not.toBeInTheDocument();
    expect(screen.getByText('new filter message')).toBeInTheDocument();
  });
});
