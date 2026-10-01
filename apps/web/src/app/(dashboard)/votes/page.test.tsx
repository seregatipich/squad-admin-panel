// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stable references: the browser keys its fetch effects on the parsed search
// params and router, so fresh objects per render would refetch forever.
const { searchParams, router } = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  router: { replace: () => undefined },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/votes',
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));

import VotesPage from './page';

const VOTE = {
  id: 'vote-1',
  server_id: 'server-1',
  server_name: 'Test server',
  server_slug: 'test-server',
  initiator_player_id: 'player-1',
  initiator_nickname: 'Инициатор',
  vote_type: 'map_skip',
  map_current: 'Narva_AAS_v1',
  map_next: 'Yehorivka_RAAS_v2',
  map_target: null,
  votes_collected: 3,
  votes_required: 5,
  result: 'passed',
  duration_seconds: 30,
  started_at: '2026-07-01T00:00:00.000Z',
  ended_at: '2026-07-01T00:00:30.000Z',
  ballot_count: 2,
};

interface Options {
  items?: unknown[];
  listStatus?: number;
  total?: number;
}

function stubFetch(opts: Options = {}): string[] {
  const urls: string[] = [];
  const items = opts.items ?? [VOTE];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('/api/v1/votes/count')) {
        return Promise.resolve(new Response(JSON.stringify({ total: opts.total ?? items.length })));
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      }
      if (url === '/api/v1/votes/vote-1') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...VOTE,
              ballots: [
                { player_id: 'p-yes', nickname: 'Согласный', choice: 'yes' },
                { player_id: 'p-no', nickname: 'Против-Игрок', choice: 'no' },
              ],
            }),
          ),
        );
      }
      if (url.startsWith('/api/v1/votes?')) {
        return Promise.resolve(
          new Response(JSON.stringify({ items, next_cursor: null, limit: 50 }), {
            status: opts.listStatus ?? 200,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VotesPage', () => {
  it('shows the loading skeleton until the votes arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<VotesPage />);

    expect(await screen.findByText('Загрузка голосований')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders a vote with its initiator, map chain, result and tally', async () => {
    const urls = stubFetch({ total: 1 });
    render(<VotesPage />);

    expect(await screen.findByRole('link', { name: 'Инициатор' })).toHaveAttribute(
      'href',
      '/all-players/player-1',
    );
    expect(screen.getByText('Narva_AAS_v1')).toBeInTheDocument();
    expect(screen.getByText('Yehorivka_RAAS_v2')).toBeInTheDocument();
    expect(screen.getByText('Скип карты', { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByText('Принято', { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByText('/5')).toBeInTheDocument();
    expect(screen.getByText('Больше голосований нет')).toBeInTheDocument();
    expect(urls.some((url) => url.startsWith('/api/v1/votes?'))).toBe(true);
  });

  it('shows the total from the count endpoint in the header', async () => {
    stubFetch({ total: 42 });
    render(<VotesPage />);

    expect(await screen.findByText('всего: 42')).toBeInTheDocument();
  });

  it('shows the empty state when no vote was ever recorded', async () => {
    stubFetch({ items: [], total: 0 });
    render(<VotesPage />);

    expect(await screen.findByText('Голосований ещё не было')).toBeInTheDocument();
  });

  it('shows an error banner when the list request fails', async () => {
    stubFetch({ listStatus: 500 });
    render(<VotesPage />);

    expect(await screen.findByText('Не удалось загрузить голосования')).toBeInTheDocument();
    expect(screen.getByText('Сервер вернул ошибку (код 500).')).toBeInTheDocument();
  });

  it('loads the named ballots when the voters row is expanded', async () => {
    stubFetch();
    render(<VotesPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Проголосовавшие \(2\)/ }));

    expect(await screen.findByRole('link', { name: /Согласный/ })).toHaveAttribute(
      'href',
      '/all-players/p-yes',
    );
    expect(screen.getByRole('link', { name: /Против-Игрок/ })).toBeInTheDocument();
  });
});
