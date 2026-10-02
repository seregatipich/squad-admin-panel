// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace })),
  usePathname: vi.fn(() => '/matches'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));

import MatchesPage from './page';

const FINISHED_MATCH = {
  id: '11111111-1111-4111-8111-111111111111',
  server_id: 'srv-1',
  server_name: 'Сервер Альфа',
  server_slug: 'alpha',
  layer: 'Narva_AAS_v1',
  map: 'Narva',
  game_mode: 'AAS',
  team1_faction: 'USA',
  team2_faction: 'RGF',
  team1_tickets: 120,
  team2_tickets: 0,
  winner: 'team1',
  is_seed: false,
  started_at: '2026-09-25T10:00:00.000Z',
  ended_at: '2026-09-25T10:40:00.000Z',
  duration_seconds: 2400,
  end_reason: null,
};

interface Options {
  items?: unknown[];
  listStatus?: number;
  total?: number;
}

function stubFetch(opts: Options = {}): string[] {
  const items = opts.items ?? [FINISHED_MATCH];
  const listUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/matches/count')) {
        return Promise.resolve(new Response(JSON.stringify({ total: opts.total ?? items.length })));
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      }
      if (url.startsWith('/api/v1/matches?')) {
        listUrls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify({ items, next_cursor: null }), {
            status: opts.listStatus ?? 200,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return listUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
  mockSearchParams = new URLSearchParams();
});

describe('MatchesPage', () => {
  it('shows the loading skeleton until the matches arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<MatchesPage />);

    expect(await screen.findByText('Загрузка списка матчей')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders a finished match with factions, tickets, duration and winner', async () => {
    stubFetch({ total: 31 });
    render(<MatchesPage />);

    const table = await screen.findByRole('table', { name: 'Матчи' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByRole('link', { name: 'alpha' })).toHaveAttribute(
      'href',
      expect.stringContaining('/matches/11111111-1111-4111-8111-111111111111'),
    );
    expect(within(row).getByText('Narva_AAS_v1')).toBeInTheDocument();
    expect(within(row).getByText('USA')).toBeInTheDocument();
    expect(within(row).getByText('120')).toBeInTheDocument();
    expect(within(row).getByText('RGF')).toBeInTheDocument();
    expect(within(row).getByText('Команда 1')).toBeInTheDocument();
    expect(screen.getByText('всего: 31')).toBeInTheDocument();
    expect(screen.getByText('Больше матчей нет')).toBeInTheDocument();
  });

  it('marks a match without an end time as in progress', async () => {
    stubFetch({
      items: [{ ...FINISHED_MATCH, ended_at: null, winner: null, duration_seconds: null }],
    });
    render(<MatchesPage />);

    expect(await screen.findByText('Идёт')).toBeInTheDocument();
  });

  it('shows the empty state when no match was ever recorded', async () => {
    stubFetch({ items: [], total: 0 });
    render(<MatchesPage />);

    expect(await screen.findByText('Матчей ещё не было')).toBeInTheDocument();
  });

  it('shows an error banner when the list request fails', async () => {
    stubFetch({ listStatus: 500 });
    render(<MatchesPage />);

    expect(await screen.findByText('Не удалось загрузить список матчей')).toBeInTheDocument();
  });

  it('sorts by layer ascending when the Layer column header is clicked', async () => {
    stubFetch();
    render(<MatchesPage />);
    await screen.findByRole('table', { name: 'Матчи' });

    await userEvent.click(screen.getByRole('button', { name: /Layer/ }));

    expect(replace).toHaveBeenCalledWith('/matches?sort=layer&order=asc');
  });

  it('does not count the default seeding hiding as an applied filter', async () => {
    mockSearchParams = new URLSearchParams();
    stubFetch({ items: [], total: 0 });
    render(<MatchesPage />);

    expect(await screen.findByText('Матчей ещё не было')).toBeInTheDocument();
    expect(screen.queryByText('Нет совпадений.')).not.toBeInTheDocument();
  });

  it('tells an empty filter result apart from an empty history', async () => {
    mockSearchParams = new URLSearchParams('layer=Narva');
    stubFetch({ items: [], total: 0 });
    render(<MatchesPage />);

    expect(await screen.findByText('Нет совпадений.')).toBeInTheDocument();
  });

  it('restricts the request to the player from the URL', async () => {
    mockSearchParams = new URLSearchParams('player=player-7');
    const listUrls = stubFetch({ items: [] });
    render(<MatchesPage />);

    expect(await screen.findByText('Нет совпадений.')).toBeInTheDocument();
    expect(new URLSearchParams(listUrls[0]?.split('?')[1]).get('playerId')).toBe('player-7');
  });
});
