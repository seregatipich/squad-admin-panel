// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/events'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { EventsBrowser } from './EventsBrowser';

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null, limit: 50 }), {
          status: 200,
        }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

describe('EventsBrowser — BANNAME-3 rule filter chip', () => {
  it('shows no rule chip without a ?rule param', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByText(/правило:/i)).not.toBeInTheDocument();
  });

  it('shows a removable «Правило: …» chip when ?rule is set, and clears it on click', async () => {
    mockSearchParams = new URLSearchParams('rule=22222222-2222-2222-2222-222222222222');
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    const chip = await screen.findByText(/правило: 22222222/i);
    expect(chip).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /убрать фильтр по правилу/i }));
    expect(replaceMock).toHaveBeenCalledWith(expect.not.stringContaining('rule='));
  });

  it('sends ruleId on the events list/count requests when ?rule is set', async () => {
    mockSearchParams = new URLSearchParams('rule=rule-abc');
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : String(input),
    );
    expect(calledUrls.some((url) => url.includes('ruleId=rule-abc'))).toBe(true);
  });
});

describe('EventsBrowser — заголовки', () => {
  it('не рендерит собственный <h1>: на верхнем уровне его даёт страница', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('во вложенном режиме сервера даёт только заголовок раздела', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser lockedServerId="srv-1" />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Журнал событий' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

function eventItem(id: string, kind = 'player.connected', serverId = 'srv-1') {
  return {
    event_id: id,
    server_id: serverId,
    server_name: 'Server',
    server_slug: 'server',
    occurred_at: '2026-09-25T10:00:00.000Z',
    kind,
    version: 1,
    actor_kind: 'system',
    actor_id: null,
    actor_nickname: null,
    correlation_id: null,
  };
}

/** Каждый запрос списка отдаёт следующую страницу из `pages` (последняя — навсегда). */
function listFetch(pages: ReturnType<typeof eventItem>[][]) {
  let call = 0;
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      const items = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ items, next_cursor: null, limit: 50 }), { status: 200 }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function listCalls(fetchMock: ReturnType<typeof listFetch>): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === 'string' ? input : String(input);
    return url.startsWith('/api/v1/events?');
  }).length;
}

describe('EventsBrowser — живая лента', () => {
  it('подтягивает новое событие сверху, как только API сообщил о вставке', async () => {
    const fetchMock = listFetch([
      [eventItem('evt00001')],
      [eventItem('evt00002'), eventItem('evt00001')],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');
    expect(screen.queryByText('evt00002')).not.toBeInTheDocument();

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        type: 'server.events.appended',
        ts: '2026-09-25T10:00:01.000Z',
        data: { server_id: 'srv-1', kinds: ['player.connected'] },
      });
    });
    expect(await screen.findByText('evt00002', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('evt00001')).toBeInTheDocument();
    expect(listCalls(fetchMock)).toBe(2);
  });

  it('не перечитывает список, если событие не с этого сервера', async () => {
    const fetchMock = listFetch([[eventItem('evt00001')]]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await waitFor(() => expect(listCalls(fetchMock)).toBe(1));

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        type: 'server.events.appended',
        ts: '2026-09-25T10:00:01.000Z',
        data: { server_id: 'srv-other', kinds: ['player.connected'] },
      });
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(listCalls(fetchMock)).toBe(1);
  });

  it('склеивает пачку уведомлений в одно перечитывание', async () => {
    const fetchMock = listFetch([
      [eventItem('evt00001')],
      [eventItem('evt00002'), eventItem('evt00001')],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await waitFor(() => expect(listCalls(fetchMock)).toBe(1));

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        liveHandlers.get('server.events.appended')?.({
          type: 'server.events.appended',
          ts: '2026-09-25T10:00:01.000Z',
          data: { server_id: 'srv-1', kinds: ['combat_damage'] },
        });
      }
    });
    await waitFor(() => expect(listCalls(fetchMock)).toBe(2), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(listCalls(fetchMock)).toBe(2);
  });

  /*
   * EVENTS-551: без сброса `liveTimerRef.current` в колбэке повторного
   * таймера первый же кадр «again» навсегда блокирует дальнейшие живые
   * обновления через `onEventsAppended`.
   */
  it('продолжает живые обновления после кадра, пришедшего во время первого перечитывания', async () => {
    let resolveFirst: (() => void) | undefined;
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/events/count')) {
          return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/events')) {
          call += 1;
          if (call === 1) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ items: [eventItem('evt00001')], next_cursor: null, limit: 50 }),
                { status: 200 },
              ),
            );
          }
          if (call === 2) {
            // The refresh triggered by the first live frame: stays in flight
            // long enough for a second frame to arrive while it is pending.
            return new Promise<Response>((resolve) => {
              resolveFirst = () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      items: [eventItem('evt00002'), eventItem('evt00001')],
                      next_cursor: null,
                      limit: 50,
                    }),
                    { status: 200 },
                  ),
                );
            });
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [eventItem('evt00003'), eventItem('evt00002'), eventItem('evt00001')],
                next_cursor: null,
                limit: 50,
              }),
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
    render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');

    // The live refresh is throttled to one per LIVE_REFRESH_MS, so the test
    // drives the throttle timers with a fake clock instead of real waits.
    const LIVE_REFRESH_MS = 5000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const advance = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      const frame = (ts: string) =>
        act(async () => {
          liveHandlers.get('server.events.appended')?.({
            type: 'server.events.appended',
            ts,
            data: { server_id: 'srv-1', kinds: ['player.connected'] },
          });
        });

      // First frame: starts the in-flight refresh (call === 2, held pending).
      await frame('2026-09-25T10:00:01.000Z');
      await advance(1);
      expect(call).toBe(2);

      // Second frame while the refresh above is still in flight: this schedules
      // its *own* timer (liveTimerRef.current was already reset to null right
      // before refreshHead's call above started).
      await frame('2026-09-25T10:00:01.500Z');

      // Let that second timer fire *before* the first refresh resolves: it
      // calls refreshHead reentrantly while `live.inFlight` is still true,
      // which is what actually sets `live.again = true` (a plain, early
      // return — it never touches liveTimerRef.current itself).
      await advance(LIVE_REFRESH_MS + 1);
      expect(call).toBe(2);

      // The in-flight refresh (call #2) now resolves; its `finally` block sees
      // `live.again` and schedules the buggy, never-reset retry timer.
      await act(async () => {
        resolveFirst?.();
        await Promise.resolve();
      });
      expect(screen.getByText('evt00002')).toBeInTheDocument();
      // Let the "again" retry timer fire.
      await advance(LIVE_REFRESH_MS + 1);
      expect(call).toBe(3);

      // A further frame after the retry fired must still trigger a refresh —
      // before the fix, liveTimerRef.current was left non-null forever here.
      await frame('2026-09-25T10:00:03.000Z');
      await advance(LIVE_REFRESH_MS + 1);
      expect(call).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * EVENTS-553: `loadMore`/`refreshHead` не защищены счётчиком поколений от
 * своего же старого запроса, начатого под старыми фильтрами.
 */
describe('EventsBrowser — EVENTS-553 устаревшие ответы после смены фильтра', () => {
  it('отбрасывает ответ подгрузки, начатой до смены фильтра', async () => {
    let resolveStaleLoadMore: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/events/count')) {
          return Promise.resolve(new Response(JSON.stringify({ total: 2 }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/events')) {
          if (url.includes('cursor=cursor-1')) {
            // The stale loadMore: held pending until the test resolves it,
            // after the filter has already changed.
            return new Promise<Response>((resolve) => {
              resolveStaleLoadMore = () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      items: [eventItem('evtstale')],
                      next_cursor: null,
                      limit: 50,
                    }),
                    { status: 200 },
                  ),
                );
            });
          }
          if (url.includes('kind=player.disconnected')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  items: [eventItem('evtfltrd', 'player.disconnected')],
                  next_cursor: null,
                  limit: 50,
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [eventItem('evt00001')],
                next_cursor: 'cursor-1',
                limit: 50,
              }),
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

    const { rerender } = render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');

    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(resolveStaleLoadMore).toBeDefined());

    // Filter changes while the loadMore above is still in flight: a new
    // first page loads and replaces the list.
    mockSearchParams = new URLSearchParams('kinds=player.disconnected');
    rerender(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evtfltrd');

    // The stale loadMore now resolves — it must not be spliced onto the
    // filtered list.
    await act(async () => {
      resolveStaleLoadMore?.();
      await Promise.resolve();
    });

    expect(screen.queryByText('evtstale')).not.toBeInTheDocument();
    expect(screen.getByText('evtfltrd')).toBeInTheDocument();
  });
});

/*
 * EVENTS-1336: одно живое перечитывание запрашивает только первую страницу
 * (PAGE_LIMIT=50); больше 50 новых событий между обновлениями раньше
 * пропадали безвозвратно.
 */
describe('EventsBrowser — EVENTS-1336 догонка более одной страницы', () => {
  it('запрашивает следующую страницу, если первая страница не пересекается с уже известными строками', async () => {
    let firstPageCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/v1/events/count')) {
        return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
      }
      if (url.startsWith('/api/v1/events')) {
        if (url.includes('cursor=page-2')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [eventItem('evtnew51'), eventItem('evt00001')],
                next_cursor: null,
                limit: 50,
              }),
              { status: 200 },
            ),
          );
        }
        // No cursor: the initial mount request, then every refreshHead call
        // (which always starts from the first page). The first one seeds a
        // single known row; every one after that is the live catch-up,
        // returning a page full of brand-new rows that doesn't overlap the
        // known row yet, forcing a second (cursor=page-2) page.
        firstPageCalls += 1;
        if (firstPageCalls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ items: [eventItem('evt00001')], next_cursor: null, limit: 50 }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: Array.from({ length: 50 }, (_, i) =>
                eventItem(`evtnew${String(i).padStart(2, '0')}`),
              ),
              next_cursor: 'page-2',
              limit: 50,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        type: 'server.events.appended',
        ts: '2026-09-25T10:00:01.000Z',
        data: { server_id: 'srv-1', kinds: ['combat_damage'] },
      });
    });

    // The catch-up walked a second page and found the previously-known row,
    // so the burst of 50 new rows is not lost.
    expect(await screen.findByText('evtnew51')).toBeInTheDocument();
    expect(screen.getByText('evt00001')).toBeInTheDocument();
  });
});

/*
 * EVENTS-552: `loadMore` used to list `loadingMore` in its own dependency
 * array, so every toggle recreated it — and with it, the IntersectionObserver
 * effect that depends on it — while a stuck-visible sentinel could refire the
 * (recreated) callback immediately, busy-retrying a persistently failing
 * `loadMore` with no backoff.
 */
describe('EventsBrowser — EVENTS-552 без бесконечного авто-повтора после ошибки', () => {
  it('не переустанавливает наблюдатель при каждом переключении loadingMore и не повторяет провалившуюся подгрузку сама', async () => {
    let observerCtorCalls = 0;
    let latestCallback: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCtorCalls += 1;
        latestCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    let loadMoreCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/events/count')) {
          return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/events')) {
          if (url.includes('cursor=')) {
            loadMoreCalls += 1;
            return Promise.resolve(new Response(null, { status: 500 }));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({ items: [eventItem('evt00001')], next_cursor: 'cur1', limit: 50 }),
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
    render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');
    expect(observerCtorCalls).toBe(1);

    // The sentinel "intersects": loadMore runs, fails, and toggles
    // loadingMore true→false without ever recreating the observer.
    await act(async () => {
      latestCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
      await Promise.resolve();
    });
    await waitFor(() => expect(loadMoreCalls).toBe(1));
    expect(observerCtorCalls).toBe(1);

    // The sentinel is still (or again) visible: without the fix, the
    // recreated `loadMore`/observer would fire again immediately with no
    // backoff. The failed-load flag must block this until the visible
    // "Показать ещё" button is used instead.
    await act(async () => {
      latestCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(loadMoreCalls).toBe(1);

    // The visible button clears the failed flag and retries once more.
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(loadMoreCalls).toBe(2));
  });
});

describe('EventsBrowser — счётчик событий', () => {
  function countFetch(count: { total: number; estimated?: boolean }) {
    return vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/v1/events/count')) {
        return Promise.resolve(new Response(JSON.stringify(count), { status: 200 }));
      }
      return mockFetch()(input);
    });
  }

  it('показывает точное число, когда API посчитал события', async () => {
    vi.stubGlobal('fetch', countFetch({ total: 42, estimated: false }));
    render(<EventsBrowser />);
    expect(await screen.findByText('Всего: 42')).toBeInTheDocument();
  });

  it('помечает оценку планировщика знаком «≈»', async () => {
    vi.stubGlobal('fetch', countFetch({ total: 12345678, estimated: true }));
    render(<EventsBrowser />);
    expect(await screen.findByText('Всего: ≈12345678')).toBeInTheDocument();
  });
});
