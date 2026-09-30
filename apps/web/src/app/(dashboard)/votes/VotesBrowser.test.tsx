// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useSearchParamsMock, routerReplaceMock } = vi.hoisted(() => ({
  useSearchParamsMock: vi.fn(() => new URLSearchParams()),
  routerReplaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/votes'),
  useRouter: vi.fn(() => ({ replace: routerReplaceMock })),
  useSearchParams: useSearchParamsMock,
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import type { VoteListItem } from './helpers';
import { VotesBrowser } from './VotesBrowser';

function makeVote(id: string, nickname: string): VoteListItem {
  return {
    id,
    server_id: 'server-1',
    server_name: 'Test server',
    server_slug: 'test-server',
    initiator_player_id: `player-${id}`,
    initiator_nickname: nickname,
    vote_type: 'map_skip',
    map_current: null,
    map_next: null,
    map_target: null,
    votes_collected: 3,
    votes_required: 5,
    result: 'passed',
    duration_seconds: 30,
    started_at: '2026-07-01T00:00:00.000Z',
    ended_at: '2026-07-01T00:05:00.000Z',
    ballot_count: 3,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
});

describe('VotesBrowser', () => {
  it('is a valid React component', () => {
    expect(VotesBrowser).toBeDefined();
    expect(typeof VotesBrowser).toBe('function');
  });
});

describe('filter change discards a stale loadMore response (#750)', () => {
  it('does not append or adopt the cursor of an in-flight loadMore for the previous filters', async () => {
    const A = makeVote('vote-a', 'Alice');
    const B = makeVote('vote-b', 'Bob (stale)');
    const Z = makeVote('vote-z', 'Zed (fresh)');

    // Resolved lazily so the test controls exactly when each response lands.
    let resolveStaleLoadMore: ((res: Response) => void) | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/votes/count') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
          );
        }
        if (url.startsWith('/api/v1/votes?')) {
          const query = new URLSearchParams(url.split('?')[1]);
          const isFollowUpPage = query.has('cursor');
          const isNewFilters = query.get('voteType') === 'admin';
          if (isFollowUpPage) {
            // The only paginated request in this test is the stale one, sent
            // for the *old* filters before they changed; hold it open.
            return new Promise<Response>((resolve) => {
              resolveStaleLoadMore = resolve;
            });
          }
          if (isNewFilters) {
            return Promise.resolve(
              new Response(JSON.stringify({ items: [Z], next_cursor: null, limit: 50 }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ items: [A], next_cursor: 'cursor-a', limit: 50 }), {
              status: 200,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const { rerender } = render(<VotesBrowser />);
    await screen.findByText('Alice');
    expect(await screen.findByRole('button', { name: 'Показать ещё' })).toBeInTheDocument();

    // Start the (stale) loadMore for the current ("all") filters. It hangs.
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveStaleLoadMore).not.toBeNull();

    // The filters change (e.g. the URL now carries `type=admin`) while that
    // request is still in flight.
    useSearchParamsMock.mockReturnValue(new URLSearchParams('type=admin'));
    await act(async () => {
      rerender(<VotesBrowser />);
    });
    expect(await screen.findByText('Zed (fresh)')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    // The new filters' single page has no next cursor.
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();

    // The stale loadMore now resolves. Its rows/cursor must not land on top
    // of the new filters' list.
    await act(async () => {
      resolveStaleLoadMore?.(
        new Response(JSON.stringify({ items: [B], next_cursor: 'cursor-b', limit: 50 }), {
          status: 200,
        }),
      );
      await Promise.resolve();
    });

    expect(screen.queryByText('Bob (stale)')).not.toBeInTheDocument();
    expect(screen.getByText('Zed (fresh)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('allows loadMore again for the new filters after a filter change mid-loadMore', async () => {
    const A = makeVote('vote-a', 'Alice');
    const Z = makeVote('vote-z', 'Zed (fresh)');
    const Y = makeVote('vote-y', 'Yan (page two)');
    const followUpCursors: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/votes/count') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
          );
        }
        if (url.startsWith('/api/v1/votes?')) {
          const query = new URLSearchParams(url.split('?')[1]);
          const cursor = query.get('cursor');
          if (cursor === 'cursor-a') {
            // Stale loadMore for the old filters: never resolves.
            return new Promise<Response>(() => undefined);
          }
          if (cursor === 'cursor-z') {
            followUpCursors.push(cursor);
            return Promise.resolve(
              new Response(JSON.stringify({ items: [Y], next_cursor: null, limit: 50 }), {
                status: 200,
              }),
            );
          }
          if (query.get('voteType') === 'admin') {
            return Promise.resolve(
              new Response(JSON.stringify({ items: [Z], next_cursor: 'cursor-z', limit: 50 }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ items: [A], next_cursor: 'cursor-a', limit: 50 }), {
              status: 200,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const { rerender } = render(<VotesBrowser />);
    await screen.findByText('Alice');
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    await act(async () => {
      await Promise.resolve();
    });

    useSearchParamsMock.mockReturnValue(new URLSearchParams('type=admin'));
    await act(async () => {
      rerender(<VotesBrowser />);
    });
    await screen.findByText('Zed (fresh)');

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Yan (page two)')).toBeInTheDocument();
    expect(followUpCursors).toEqual(['cursor-z']);
  });
});
