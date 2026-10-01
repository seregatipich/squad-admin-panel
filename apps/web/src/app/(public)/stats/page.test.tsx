// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/forwarded-client', () => ({
  forwardedClientHeaders: vi.fn().mockResolvedValue({ 'x-forwarded-for': '203.0.113.9' }),
}));

import PublicStatsPage, { dynamic, metadata } from './page';

const STATS = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-30T00:00:00.000Z',
  summary: {
    total_matches: 420,
    total_online_hours: 1234.56,
    unique_players: 777,
    avg_match_duration_seconds: 2535,
  },
  peak_by_hour: [
    { hour: 0, peak_players: 10 },
    { hour: 20, peak_players: 90 },
  ],
  match_outcomes: { team1: 200, team2: 180, draw: 10, unknown: 30, total: 420 },
  popular_maps: [
    { map: 'Narva', matches: 55 },
    { map: 'Yehorivka', matches: 40 },
  ],
  popular_layers: [{ layer: 'Narva_AAS_v1', matches: 31 }],
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicStatsPage', () => {
  it('renders the network summary tiles', async () => {
    stubFetch(new Response(JSON.stringify(STATS)));
    render(await PublicStatsPage());

    expect(
      screen.getByRole('heading', { level: 1, name: 'Публичная статистика' }),
    ).toBeInTheDocument();
    expect(screen.getByText('420')).toBeInTheDocument();
    expect(screen.getByText('777')).toBeInTheDocument();
    expect(screen.getByText('1234,6 ч')).toBeInTheDocument();
    expect(screen.getByText('42 мин 15 сек')).toBeInTheDocument();
  });

  it('lists the popular maps and layers with their match counts', async () => {
    stubFetch(new Response(JSON.stringify(STATS)));
    render(await PublicStatsPage());

    const maps = screen.getByRole('table', { name: 'Популярные карты' });
    expect(within(maps).getByText('Narva')).toBeInTheDocument();
    expect(within(maps).getByText('55')).toBeInTheDocument();
    expect(within(maps).getByText('Yehorivka')).toBeInTheDocument();
    const layers = screen.getByRole('table', { name: 'Популярные слои' });
    expect(within(layers).getByText('Narva_AAS_v1')).toBeInTheDocument();
    expect(within(layers).getByText('31')).toBeInTheDocument();
  });

  it('shows the outcome split between the teams', async () => {
    stubFetch(new Response(JSON.stringify(STATS)));
    render(await PublicStatsPage());

    const outcome = (label: string) => screen.getByText(label).nextElementSibling;
    expect(outcome('Команда 1')).toHaveTextContent('200');
    expect(outcome('Команда 2')).toHaveTextContent('180');
    expect(outcome('Ничья')).toHaveTextContent('10');
    expect(outcome('Неизвестно')).toHaveTextContent('30');
  });

  it('describes each hour bar by its peak, scaling against the busiest hour', async () => {
    stubFetch(new Response(JSON.stringify(STATS)));
    render(await PublicStatsPage());

    expect(screen.getByTitle('20:00 · 90 игроков')).toHaveStyle({ height: '100%' });
    expect(screen.getByTitle('00:00 · 10 игроков')).toHaveStyle({ height: '11.11111111111111%' });
  });

  it('shows the empty state for a period without matches', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          ...STATS,
          summary: { ...STATS.summary, avg_match_duration_seconds: null },
          peak_by_hour: [],
          popular_maps: [],
          popular_layers: [],
        }),
      ),
    );
    render(await PublicStatsPage());

    expect(screen.getAllByText('Данных пока нет.')).toHaveLength(2);
    expect(screen.queryByRole('table', { name: 'Популярные карты' })).not.toBeInTheDocument();
  });

  it('requests the anonymous endpoint and relays the visitor address', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(STATS)));
    await PublicStatsPage();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/public/stats');
    expect(new Headers(init?.headers).get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('lets an API failure reach the error boundary instead of rendering a blank page', async () => {
    stubFetch(new Response('{}', { status: 503 }));

    await expect(PublicStatsPage()).rejects.toMatchObject({ status: 503 });
  });

  it('is rendered per request and titled for the public portal', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.title).toBe('Статистика — Squad Admin Panel');
  });
});
