// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchListItem } from './helpers';

let mockSearchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/matches'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { MatchesBrowser } from './MatchesBrowser';

function match(id: string, layer: string, overrides: Partial<MatchListItem> = {}): MatchListItem {
  return {
    id,
    server_id: 'srv-1',
    server_name: 'Server',
    server_slug: 'server',
    layer,
    map: layer,
    game_mode: null,
    team1_faction: null,
    team2_faction: null,
    team1_tickets: null,
    team2_tickets: null,
    winner: null,
    is_seed: false,
    started_at: '2026-09-25T10:00:00.000Z',
    ended_at: '2026-09-25T10:40:00.000Z',
    duration_seconds: 2400,
    end_reason: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

/*
 * MATCHES-1296: MatchesBrowser subscribed to 'match.started'/'match.ended',
 * live-bus events nothing ever publishes — a dead listener. New matches only
 * ever reach the browser via 'server.events.appended'.
 */
describe('MatchesBrowser — MATCHES-1296 живое обновление через server.events.appended', () => {
  it('перечитывает первую страницу, когда кадр server.events.appended несёт match.started', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/matches/count')) {
          return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/matches')) {
          call += 1;
          const layer = call === 1 ? 'Yehorivka' : 'Narva';
          return Promise.resolve(
            new Response(JSON.stringify({ items: [match('m1', layer)], next_cursor: null }), {
              status: 200,
            }),
          );
        }
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<MatchesBrowser />);
    await screen.findByText('Yehorivka');

    expect(liveHandlers.has('match.started')).toBe(false);
    expect(liveHandlers.has('server.events.appended')).toBe(true);

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        data: { server_id: 'srv-1', kinds: ['match.started'] },
      });
    });

    expect(await screen.findByText('Narva')).toBeInTheDocument();
  });
});

/*
 * MATCHES-582: loadMore/refreshHead had no request-generation check, and
 * loadFirstPage didn't reset nextCursor before its own response arrived, so
 * a sort/filter change while a loadMore/refreshHead was in flight could
 * attach stale rows or an invalid cursor to the new list.
 */
describe('MatchesBrowser — MATCHES-582 устаревшие ответы после смены сортировки', () => {
  it('отбрасывает ответ подгрузки, начатой до смены сортировки', async () => {
    let resolveStaleLoadMore: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/matches/count')) {
          return Promise.resolve(new Response(JSON.stringify({ total: 2 }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/matches')) {
          if (url.includes('cursor=cursor-1')) {
            return new Promise<Response>((resolve) => {
              resolveStaleLoadMore = () =>
                resolve(
                  new Response(
                    JSON.stringify({ items: [match('m-stale', 'Stale')], next_cursor: null }),
                    { status: 200 },
                  ),
                );
            });
          }
          if (url.includes('sort=duration_seconds')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ items: [match('m-sorted', 'Sorted')], next_cursor: null }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({ items: [match('m1', 'Yehorivka')], next_cursor: 'cursor-1' }),
              { status: 200 },
            ),
          );
        }
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const { rerender } = render(<MatchesBrowser />);
    await screen.findByText('Yehorivka');

    // Start the loadMore (held pending) via the visible "Показать ещё" button.
    await act(async () => {
      screen.getByRole('button', { name: 'Показать ещё' }).click();
    });
    await waitFor(() => expect(resolveStaleLoadMore).toBeDefined());

    // Sort changes while the loadMore above is still in flight.
    mockSearchParams = new URLSearchParams('sort=duration_seconds');
    rerender(<MatchesBrowser />);
    await screen.findByText('Sorted');

    // The stale loadMore now resolves — it must not be spliced onto the
    // list under the new sort.
    await act(async () => {
      resolveStaleLoadMore?.();
      await Promise.resolve();
    });

    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.getByText('Sorted')).toBeInTheDocument();
  });
});
