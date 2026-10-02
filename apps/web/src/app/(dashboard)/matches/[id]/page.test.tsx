// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));

import MatchDetailPage from './page';

const MATCH_ID = '22222222-2222-4222-8222-222222222222';

const TEAM_AGGREGATE = {
  players: 1,
  play_seconds: 3600,
  kills: 5,
  deaths: 1,
  teamkills: 0,
  wounds: 2,
  revives: 1,
};

const MATCH = {
  id: MATCH_ID,
  server_id: 'srv-1',
  server_name: 'Сервер Альфа',
  server_slug: 'alpha',
  layer: 'Yehorivka_RAAS_v1',
  map: 'Yehorivka',
  game_mode: 'RAAS',
  team1_faction: 'RGF',
  team2_faction: 'USA',
  team1_tickets: 120,
  team2_tickets: 80,
  winner: 'team1',
  is_seed: false,
  started_at: '2026-05-21T10:00:00.000Z',
  ended_at: '2026-05-21T11:00:00.000Z',
  duration_seconds: 3600,
  end_reason: 'ended',
  roster: [
    {
      player_id: 'player-1',
      nickname: 'Рядовой Иванов',
      team: 1,
      squad_name: 'Alpha',
      play_seconds: 3600,
      left_at: null,
      left_early: false,
      kills: 5,
      deaths: 1,
      teamkills: 0,
      wounds: 2,
      revives: 1,
    },
  ],
  teams: {
    team1: TEAM_AGGREGATE,
    team2: { ...TEAM_AGGREGATE, players: 0, play_seconds: 0 },
  },
  previous_match: null,
  next_match: null,
  combat_events: null,
};

function stubFetch(response: () => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(response());
    }),
  );
  return urls;
}

async function renderPage(id: string, from?: string) {
  await act(async () => {
    render(
      <Suspense fallback={<p>страница грузится</p>}>
        <MatchDetailPage
          params={Promise.resolve({ id })}
          searchParams={Promise.resolve(from === undefined ? {} : { from })}
        />
      </Suspense>,
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MatchDetailPage', () => {
  it('shows the loading skeleton while the match is requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    await renderPage(MATCH_ID);

    expect(await screen.findByText('Загрузка матча')).toBeInTheDocument();
  });

  it('requests the match from the route id and renders its header, factions and roster', async () => {
    const urls = stubFetch(() => new Response(JSON.stringify(MATCH)));
    await renderPage(MATCH_ID);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Yehorivka_RAAS_v1' }),
    ).toBeVisible();
    expect(urls[0]).toBe(`/api/v1/matches/${MATCH_ID}`);
    expect(screen.getByText('Сервер Альфа')).toBeInTheDocument();
    expect(screen.getByText('Рядовой Иванов')).toBeInTheDocument();
    expect(screen.getByText('Победа')).toBeInTheDocument();
    expect(screen.getByText('Поражение')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('links back to the list the operator came from', async () => {
    stubFetch(() => new Response(JSON.stringify(MATCH)));
    await renderPage(MATCH_ID, '/matches?sort=layer&order=asc');

    expect(await screen.findByRole('link', { name: /К списку матчей/ })).toHaveAttribute(
      'href',
      '/matches?sort=layer&order=asc',
    );
  });

  it('ignores a back link that leaves the matches section', async () => {
    stubFetch(() => new Response(JSON.stringify(MATCH)));
    await renderPage(MATCH_ID, '//evil.example/matches');

    expect(await screen.findByRole('link', { name: /К списку матчей/ })).toHaveAttribute(
      'href',
      '/matches',
    );
  });

  it('reports a match that does not exist', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    await renderPage(MATCH_ID);

    expect(await screen.findByText('Не удалось открыть матч')).toBeInTheDocument();
    expect(screen.getByText('Матч не найден')).toBeInTheDocument();
  });

  it('refuses a route id that is not a UUID without calling the API', async () => {
    const urls = stubFetch(() => new Response(JSON.stringify(MATCH)));
    await renderPage('../servers');

    expect(await screen.findByText('Некорректный идентификатор матча')).toBeInTheDocument();
    expect(urls).toHaveLength(0);
  });

  it('retries the request after a server error', async () => {
    let attempt = 0;
    const urls = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify(MATCH));
    });
    await renderPage(MATCH_ID);

    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Yehorivka_RAAS_v1' }),
    ).toBeVisible();
    expect(urls).toHaveLength(2);
  });
});
