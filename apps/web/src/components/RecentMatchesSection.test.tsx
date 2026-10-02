// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentMatchesSection } from './RecentMatchesSection';

function match(overrides: Record<string, unknown>) {
  return {
    match_id: 'm-1',
    server_id: 's-1',
    server_name: 'Сервер Альфа',
    server_slug: 'alpha',
    layer: 'Narva_AAS_v1',
    map: 'Narva',
    game_mode: 'AAS',
    winner: 'team1',
    is_seed: false,
    started_at: '2026-03-01T10:00:00.000Z',
    ended_at: '2026-03-01T11:00:00.000Z',
    duration_seconds: 3600,
    team: 1,
    play_seconds: 3725,
    outcome: 'win',
    ...overrides,
  };
}

const SUMMARY = {
  recent: [
    match({ match_id: 'm-1' }),
    match({
      match_id: 'm-2',
      server_slug: null,
      server_name: 'Сервер Бета',
      layer: null,
      play_seconds: 125,
      outcome: 'loss',
    }),
    match({ match_id: 'm-3', ended_at: null, outcome: null, play_seconds: 30 }),
  ],
  winrate: { wins: 1, losses: 1, draws: 0, decided: 2, considered: 3, window: 20 },
};

function stubFetch(responses: Response[]) {
  const queue = [...responses];
  const fetchMock = vi.fn((_input: RequestInfo | URL) =>
    Promise.resolve(queue.shift() ?? new Response('{}', { status: 500 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecentMatchesSection', () => {
  it('shows a loading skeleton while the request is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<RecentMatchesSection playerId="p-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Загрузка матчей');
  });

  it('renders each match with server, layer, play time and outcome', async () => {
    const fetchMock = stubFetch([new Response(JSON.stringify(SUMMARY))]);
    render(<RecentMatchesSection playerId="p-1" />);

    const table = await screen.findByRole('table', { name: 'Последние матчи' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/players/p-1/match-summary');

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('alpha')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Narva_AAS_v1')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('1ч 2м')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Победа')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Сервер Бета')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('—')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('2м 5с')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Поражение')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('В процессе')).toBeInTheDocument();
  });

  it('summarises the winrate in the header and links to the player match list', async () => {
    stubFetch([new Response(JSON.stringify(SUMMARY))]);
    render(<RecentMatchesSection playerId="p 1" />);

    expect(await screen.findByText('Побед 1 из 2 · 50%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Все матчи' })).toHaveAttribute(
      'href',
      '/matches?player=p%201',
    );
  });

  it('links every match date to its match page', async () => {
    stubFetch([new Response(JSON.stringify(SUMMARY))]);
    render(<RecentMatchesSection playerId="p-1" />);

    const links = await screen.findAllByTitle('Открыть матч');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/matches/m-1',
      '/matches/m-2',
      '/matches/m-3',
    ]);
  });

  it('shows the empty state when the player has no matches', async () => {
    stubFetch([
      new Response(
        JSON.stringify({
          recent: [],
          winrate: { wins: 0, losses: 0, draws: 0, decided: 0, considered: 0, window: 20 },
        }),
      ),
    ]);
    render(<RecentMatchesSection playerId="p-1" />);

    expect(await screen.findByText('Матчей нет')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('rejects a body that does not match the contract', async () => {
    stubFetch([new Response(JSON.stringify({ recent: 'nope' }))]);
    render(<RecentMatchesSection playerId="p-1" />);

    expect(await screen.findByText('Не удалось загрузить матчи')).toBeInTheDocument();
    expect(screen.getByText('Неверный формат ответа')).toBeInTheDocument();
  });

  it('shows the HTTP status on failure and loads again on retry', async () => {
    const fetchMock = stubFetch([
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify(SUMMARY)),
    ]);
    render(<RecentMatchesSection playerId="p-1" />);

    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('table', { name: 'Последние матчи' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
