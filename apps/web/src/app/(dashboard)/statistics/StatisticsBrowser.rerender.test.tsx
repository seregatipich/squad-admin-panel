// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/statistics'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const chartRenders = vi.hoisted(() => vi.fn());
vi.mock('next/dynamic', () => ({
  default: () => (props: { onDrill?: (serverId: string, key: string) => void }) => {
    chartRenders();
    return props.onDrill ? (
      <button type="button" onClick={() => props.onDrill?.(SERVER_A, '2026-07-01')}>
        drill
      </button>
    ) : null;
  },
}));

import type { StatisticsResponse, StatisticsSeries } from './helpers';
import { StatisticsBrowser } from './StatisticsBrowser';

const SERVER_A = '019e0000-0000-7000-8000-0000000000a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000000b2';

const SERIES: StatisticsSeries = {
  by_server: [{ server_id: SERVER_A, points: [{ key: '2026-07-01', value: 1 }] }],
  totals: [{ key: '2026-07-01', value: 1 }],
  kpi: { avg: 1, max: 1, total: 1 },
};

const DATA: StatisticsResponse = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-01T23:59:59.999Z',
  days: ['2026-07-01'],
  servers: [
    { server_id: SERVER_A, display_name: 'Main' },
    { server_id: SERVER_B, display_name: 'Second' },
  ],
  population: {
    avg_online: SERIES,
    peak_online: SERIES,
    avg_queue: SERIES,
    by_hour: SERIES,
    by_weekday: SERIES,
  },
  matches: { by_day: SERIES, modes: [], maps: [] },
  community: { new_players: SERIES, chat_messages: SERIES, teamkills: SERIES },
  moderation: { punishments: SERIES, avg_admins: SERIES, peak_admins: SERIES },
};

beforeEach(() => {
  chartRenders.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const body = String(input).startsWith('/api/v1/statistics')
        ? DATA
        : {
            items: [
              { id: SERVER_A, display_name: 'Main' },
              { id: SERVER_B, display_name: 'Second' },
            ],
          };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StatisticsBrowser re-rendering', () => {
  it('does not re-render the charts when the server dropdown is opened or a checkbox is ticked (#734)', async () => {
    await act(async () => {
      render(<StatisticsBrowser />);
    });
    await screen.findByText('Население');
    const rendersAfterLoad = chartRenders.mock.calls.length;
    expect(rendersAfterLoad).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Все серверы/ }));
    fireEvent.click(screen.getByLabelText('Main'));

    expect(chartRenders.mock.calls.length).toBe(rendersAfterLoad);
  });

  it('drops the drill-down link once a new selection loads new data (#733)', async () => {
    await act(async () => {
      render(<StatisticsBrowser />);
    });
    await screen.findByText('Население');

    fireEvent.click(screen.getAllByRole('button', { name: 'drill' })[0] as HTMLElement);
    expect(screen.getByText('Открыть выбранный срез →')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Все серверы/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByLabelText('Main'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Серверов: 1/ }));
    });

    await waitFor(() =>
      expect(screen.queryByText('Открыть выбранный срез →')).not.toBeInTheDocument(),
    );
  });
});
