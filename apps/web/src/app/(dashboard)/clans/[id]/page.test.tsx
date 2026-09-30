// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/clans/x'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClanDetailPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const CLAN = {
  id: '00000000-0000-0000-0000-0000000000c1',
  name: 'Альфа',
  tags: ['ALF'],
  description: 'Описание клана',
  is_tag_protected: false,
  is_public: true,
  max_priority_slots: 10,
  priority_count: 0,
  priority_expires_at: null,
  primary_server_id: null,
};

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/v1/clans/00000000-0000-0000-0000-0000000000c1') return json(CLAN);
    if (url === '/api/v1/clans/00000000-0000-0000-0000-0000000000c1/online')
      return json({ clan_id: '00000000-0000-0000-0000-0000000000c1', servers: [] });
    if (url.startsWith('/api/v1/clans/00000000-0000-0000-0000-0000000000c1/matches')) {
      return json({
        clan_id: '00000000-0000-0000-0000-0000000000c1',
        items: [],
        next_cursor: null,
        limit: 20,
      });
    }
    if (url === '/api/v1/servers') return json({ items: [] });
    if (url === '/api/v1/me') return json({ can_manage_clans: true });
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClanDetailPage', () => {
  it('is a valid React component', () => {
    expect(ClanDetailPage).toBeDefined();
    expect(typeof ClanDetailPage).toBe('function');
  });

  it(
    'keeps the clan settings draft across the page’s one-second session ticker',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      const params = Promise.resolve({ id: '00000000-0000-0000-0000-0000000000c1' });
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <ClanDetailPage params={params} />
          </Suspense>,
        );
      });

      const nameInput = await screen.findByDisplayValue('Альфа');
      fireEvent.change(nameInput, { target: { value: 'Альфа Прайм' } });

      // Тикер длительности сессий перерисовывает страницу раз в секунду.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));

      expect(screen.getByDisplayValue('Альфа Прайм')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it('rejects a non-UUID clan id instead of interpolating it into API paths (#514)', async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const params = Promise.resolve({ id: '../../admin' });
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ClanDetailPage params={params} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('Некорректный идентификатор клана.')).toBeInTheDocument();
    const clanUrls = fetchSpy.mock.calls
      .map(([input]) => (typeof input === 'string' ? input : String(input)))
      .filter((url) => url.startsWith('/api/v1/clans/'));
    expect(clanUrls).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function matchItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'match-1',
    server_id: 'srv-1',
    server_name: 'Сервер 1',
    server_slug: null,
    layer: null,
    map: 'InitialMap',
    team1_faction: null,
    team2_faction: null,
    team1_tickets: null,
    team2_tickets: null,
    winner: null,
    is_seed: false,
    started_at: '2026-07-01T10:00:00.000Z',
    ended_at: null,
    duration_seconds: null,
    clan_participants_count: 1,
    participants: [],
    ...overrides,
  };
}

describe('ClanDetailPage — race between loadMatches() calls (#519)', () => {
  it('ignores a stale "Показать ещё" response that resolves after a newer server-filter load', async () => {
    const firstPage = {
      clan_id: 'clan-1',
      items: [
        matchItem({
          id: 'match-1',
          server_id: 'srv-1',
          server_name: 'Сервер 1',
          map: 'InitialMap',
        }),
        matchItem({
          id: 'match-2',
          server_id: 'srv-2',
          server_name: 'Сервер 2',
          map: 'OtherServerMap',
        }),
      ],
      next_cursor: 'CURSOR_1',
      limit: 20,
    };
    const filteredPage = {
      clan_id: 'clan-1',
      items: [
        matchItem({
          id: 'match-3',
          server_id: 'srv-2',
          server_name: 'Сервер 2',
          map: 'FilteredMap',
        }),
      ],
      next_cursor: null,
      limit: 20,
    };

    let matchesCalls = 0;
    const staleLoadMore = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/clans/clan-1') return json(CLAN);
      if (url === '/api/v1/clans/clan-1/online') return json({ clan_id: 'clan-1', servers: [] });
      if (url === '/api/v1/servers') return json({ items: [] });
      if (url === '/api/v1/me') return json({ can_manage_clans: true });
      if (url.startsWith('/api/v1/clans/clan-1/matches')) {
        matchesCalls += 1;
        if (matchesCalls === 1) return json(firstPage);
        if (matchesCalls === 2) return staleLoadMore.promise;
        return json(filteredPage);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const params = Promise.resolve({ id: 'clan-1' });
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ClanDetailPage params={params} />
        </Suspense>,
      );
    });

    await screen.findByText('InitialMap');
    await screen.findByText('OtherServerMap');

    fireEvent.click(screen.getByRole('button', { name: /показать ещё/i }));
    await vi.waitFor(() => expect(matchesCalls).toBe(2));

    // Change the server filter while the "Показать ещё" request is in flight.
    const select = screen.getByRole('combobox', { name: /сервер матча/i });
    fireEvent.change(select, { target: { value: 'srv-2' } });
    await screen.findByText('FilteredMap');
    expect(screen.queryByText('InitialMap')).not.toBeInTheDocument();
    expect(screen.queryByText('OtherServerMap')).not.toBeInTheDocument();

    // The stale loadMore() response now resolves.
    staleLoadMore.resolve(
      new Response(
        JSON.stringify({
          clan_id: 'clan-1',
          items: [matchItem({ id: 'match-stale', server_id: 'srv-1', map: 'StaleMap' })],
          next_cursor: 'STALE',
          limit: 20,
        }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText('StaleMap')).not.toBeInTheDocument();
    expect(screen.getByText('FilteredMap')).toBeInTheDocument();
  });
});
