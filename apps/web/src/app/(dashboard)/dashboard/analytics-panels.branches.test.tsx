// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { AnalyticsPanel } from './analytics-panel';
import { VoteAnalyticsPanel } from './vote-analytics-panel';

const SERVERS = [{ id: 's1', display_name: 'Main' }];

const ANALYTICS = {
  server_id: null,
  from: '2026-07-17T00:00:00.000Z',
  to: '2026-07-24T00:00:00.000Z',
  summary: {
    total_matches: 1234,
    total_online_hours: 56.7,
    unique_players: 89,
    avg_match_duration_seconds: 1830,
  },
  // Include a zero and a positive hour to exercise the bar-height ternary both ways.
  peak_by_hour: [
    { hour: 0, peak_players: 0 },
    { hour: 1, peak_players: 12 },
  ],
  // unknown: 0 exercises the `seg.count > 0` filter's false branch.
  match_outcomes: { team1: 10, team2: 8, draw: 2, unknown: 0, total: 20 },
  popular_maps: [
    { map: 'Yehorivka', matches: 12 },
    { map: 'Narva', matches: 5 },
  ],
  popular_layers: [{ layer: 'AAS v1', matches: 9 }],
};

const ANALYTICS_EMPTY = {
  ...ANALYTICS,
  summary: { ...ANALYTICS.summary, total_matches: 0, avg_match_duration_seconds: null },
  match_outcomes: { team1: 0, team2: 0, draw: 0, unknown: 0, total: 0 },
  popular_maps: [],
  popular_layers: [],
};

const VOTES = {
  server_id: null,
  from: '2026-06-24T00:00:00.000Z',
  to: '2026-07-24T00:00:00.000Z',
  summary: { total_votes: 120, passed: 80, failed: 30, cancelled: 10, pass_rate: 70 },
  pass_rate_by_server: [
    { server_id: 's1', server_name: 'Main', total: 60, passed: 40, pass_rate: 66.6 },
    { server_id: 's2', server_name: null, total: 60, passed: 40, pass_rate: 66.6 },
  ],
  pass_rate_by_map: [{ map: 'Yehorivka', total: 50, passed: 30, pass_rate: 60 }],
  trend: [
    { day: '2026-07-20', count: 0 },
    { day: '2026-07-21', count: 10 },
  ],
  // success_ratio 40 → amber tone, 10 → red tone (summary pass_rate 70 → emerald)
  top_initiators: [
    { player_id: 'p1', nickname: 'Init', initiated: 20, passed: 8, success_ratio: 40 },
    { player_id: 'p2', nickname: null, initiated: 10, passed: 1, success_ratio: 10 },
  ],
  by_hour: [
    { hour: 0, count: 0 },
    { hour: 1, count: 7 },
  ],
  serial_skippers: [
    { player_id: 'p3', nickname: 'Skipper', skip_count: 5 },
    { player_id: 'p4', nickname: null, skip_count: 3 },
  ],
};

const VOTES_EMPTY_SECTIONS = {
  ...VOTES,
  trend: [],
  pass_rate_by_server: [],
  pass_rate_by_map: [],
  top_initiators: [],
  serial_skippers: [],
};

let analyticsResponse: { status: number; body: unknown } = { status: 200, body: ANALYTICS };
let votesResponse: { status: number; body: unknown } = { status: 200, body: VOTES };

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.startsWith('/api/v1/analytics/dashboard')) {
        return Promise.resolve(
          new Response(JSON.stringify(analyticsResponse.body), {
            status: analyticsResponse.status,
          }),
        );
      }
      if (url.startsWith('/api/v1/analytics/votes')) {
        return Promise.resolve(
          new Response(JSON.stringify(votesResponse.body), { status: votesResponse.status }),
        );
      }
      return Promise.resolve(new Response('nf', { status: 404 }));
    }),
  );
}

let createObjectURLMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  analyticsResponse = { status: 200, body: ANALYTICS };
  votesResponse = { status: 200, body: VOTES };
  installFetch();
  createObjectURLMock = vi.fn(() => 'blob:mock');
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURLMock;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = undefined;
});

async function mount(node: ReactElement) {
  await act(async () => {
    render(node);
  });
}

describe('AnalyticsPanel — branch coverage', () => {
  it('renders the full dashboard once the post-mount range is set and data loads', async () => {
    await mount(<AnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('Матчей')).toBeInTheDocument();
    expect(screen.getByText('Популярные карты')).toBeInTheDocument();
    expect(screen.getByText('Yehorivka')).toBeInTheDocument();
    // Outcome legend rendered (total > 0 branch)
    expect(screen.getByText(/Исходы матчей \(20\)/)).toBeInTheDocument();
  });

  it('renders empty outcome and ranked-bar states', async () => {
    analyticsResponse = { status: 200, body: ANALYTICS_EMPTY };
    await mount(<AnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('Матчей за период нет.')).toBeInTheDocument();
    // Both RankedBars fall back to "Нет данных."
    expect(screen.getAllByText('Нет данных.').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the error branch when the request fails', async () => {
    analyticsResponse = { status: 500, body: {} };
    await mount(<AnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('ошибка 500')).toBeInTheDocument();
  });

  it('exports JSON when data is present', async () => {
    await mount(<AnalyticsPanel servers={SERVERS} />);
    await screen.findByText('Матчей');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });
});

describe('VoteAnalyticsPanel — branch coverage', () => {
  it('renders the full vote dashboard with all tone branches', async () => {
    await mount(<VoteAnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('Всего голосований')).toBeInTheDocument();
    expect(screen.getByText('Топ инициаторов')).toBeInTheDocument();
    expect(screen.getByText('Серийные скиперы')).toBeInTheDocument();
    // nickname ?? player_id fallback: p2 has null nickname
    expect(screen.getByText('p2')).toBeInTheDocument();
    expect(screen.getByText('Init')).toBeInTheDocument();
  });

  it('renders the no-votes empty state', async () => {
    votesResponse = {
      status: 200,
      body: { ...VOTES, summary: { ...VOTES.summary, total_votes: 0 } },
    };
    await mount(<VoteAnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('За выбранный период голосований нет.')).toBeInTheDocument();
  });

  it('renders the per-section empty fallbacks', async () => {
    votesResponse = { status: 200, body: VOTES_EMPTY_SECTIONS };
    await mount(<VoteAnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('Порог не достигнут никем.')).toBeInTheDocument();
    // trend, pass-rate lists and initiators all fall back to "Нет данных."
    expect(screen.getAllByText('Нет данных.').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the error branch when the request fails', async () => {
    votesResponse = { status: 503, body: {} };
    await mount(<VoteAnalyticsPanel servers={SERVERS} />);
    expect(await screen.findByText('ошибка 503')).toBeInTheDocument();
  });

  it('exports JSON when data is present', async () => {
    await mount(<VoteAnalyticsPanel servers={SERVERS} />);
    await screen.findByText('Всего голосований');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });
});
