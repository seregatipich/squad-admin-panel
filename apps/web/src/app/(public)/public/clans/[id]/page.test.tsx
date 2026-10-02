// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/forwarded-client', () => ({
  forwardedClientHeaders: vi.fn().mockResolvedValue({}),
}));
// Mirrors Next's `notFound()`, which throws to abort rendering.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

import PublicClanPage, { generateMetadata } from './page';

const CLAN = {
  id: 'clan-1',
  name: 'Альфа',
  tags: ['ALF', 'A1'],
  description: 'Играем по вечерам',
  roster: [
    { nickname: 'Лидер', role: 'Командир' },
    { nickname: 'Боец', role: 'Рядовой' },
  ],
  activity: [
    { day: '2026-09-01', online_seconds: 7200 },
    { day: '2026-09-02', online_seconds: 3600 },
  ],
  stats: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T00:00:00.000Z',
    roster_size: 2,
    online_seconds: 10800,
    matches_played: 5,
    matches_total: 9,
    kills: 30,
    deaths: 20,
    revives: 4,
    kd: 1.5,
  },
  matches: [
    {
      id: 'm-1',
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'Альфа',
      is_seed: false,
      started_at: '2026-09-20T10:00:00.000Z',
      ended_at: '2026-09-20T11:00:00.000Z',
      duration_seconds: 3600,
    },
  ],
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublicClanPage', () => {
  it('renders the clan header with its tags and a link back to the directory', async () => {
    stubFetch(new Response(JSON.stringify(CLAN)));
    render(await PublicClanPage(params('clan-1')));

    expect(screen.getByRole('heading', { level: 1, name: 'Альфа' })).toBeInTheDocument();
    expect(screen.getByText('Играем по вечерам')).toBeInTheDocument();
    expect(screen.getByText('ALF')).toBeInTheDocument();
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /К списку кланов/ })).toHaveAttribute(
      'href',
      '/public/clans',
    );
  });

  it('shows the 30-day stat tiles', async () => {
    stubFetch(new Response(JSON.stringify(CLAN)));
    render(await PublicClanPage(params('clan-1')));

    expect(screen.getByText('Онлайн за 30 дней').nextElementSibling).toHaveTextContent('3,0 ч');
    expect(screen.getByText('K/D').nextElementSibling).toHaveTextContent('1.50');
    expect(screen.getByText('Участников').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Матчей').nextElementSibling).toHaveTextContent('9');
  });

  it('lists the roster and the recent matches', async () => {
    stubFetch(new Response(JSON.stringify(CLAN)));
    render(await PublicClanPage(params('clan-1')));

    const roster = screen.getByRole('table', { name: 'Состав клана Альфа' });
    expect(within(roster).getByText('Лидер')).toBeInTheDocument();
    expect(within(roster).getByText('Командир')).toBeInTheDocument();
    const matches = screen.getByRole('table', { name: 'Последние матчи клана Альфа' });
    expect(within(matches).getByText('Narva')).toBeInTheDocument();
    expect(within(matches).getByText('Narva_AAS_v1')).toBeInTheDocument();
    expect(within(matches).getByText('Альфа')).toBeInTheDocument();
  });

  it('describes each activity bar by day and online hours', async () => {
    stubFetch(new Response(JSON.stringify(CLAN)));
    render(await PublicClanPage(params('clan-1')));

    expect(screen.getByTitle('2026-09-01 · 2,0 ч')).toHaveStyle({ height: '100%' });
    expect(screen.getByTitle('2026-09-02 · 1,0 ч')).toHaveStyle({ height: '50%' });
  });

  it('shows empty states for a clan without roster and match history', async () => {
    stubFetch(new Response(JSON.stringify({ ...CLAN, roster: [], matches: [], activity: [] })));
    render(await PublicClanPage(params('clan-1')));

    expect(screen.getByText('Ростер пуст.')).toBeInTheDocument();
    expect(screen.getByText('Истории матчей пока нет.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('answers 404 for an unknown or hidden clan', async () => {
    stubFetch(new Response('{}', { status: 404 }));

    await expect(PublicClanPage(params('missing'))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('lets any other API failure reach the error boundary', async () => {
    stubFetch(new Response('{}', { status: 500 }));

    await expect(PublicClanPage(params('clan-1'))).rejects.toMatchObject({ status: 500 });
  });

  it('encodes the clan id into the request path', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(CLAN)));
    await PublicClanPage(params('a/b'));

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/public/clans/a%2Fb');
  });
});

describe('PublicClanPage metadata', () => {
  it('titles the tab with the clan name and describes it', async () => {
    stubFetch(new Response(JSON.stringify(CLAN)));

    await expect(generateMetadata(params('clan-1'))).resolves.toMatchObject({
      title: 'Альфа — Squad Admin Panel',
      description: 'Играем по вечерам',
    });
  });

  it('falls back to a generic title when the clan cannot be loaded', async () => {
    stubFetch(new Response('{}', { status: 500 }));

    await expect(generateMetadata(params('clan-1'))).resolves.toEqual({
      title: 'Клан — Squad Admin Panel',
    });
  });
});
