// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/statistics'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({ default: vi.fn(() => () => null) }));

import type { StatisticsResponse, StatisticsSeries } from './helpers';
import { StatisticsBrowser } from './StatisticsBrowser';

const SERVER_A = '019e0000-0000-7000-8000-0000000000a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000000b2';

function series(a: number, b: number): StatisticsSeries {
  return {
    by_server: [
      {
        server_id: SERVER_A,
        points: [
          { key: '2026-07-01', value: a },
          { key: '2026-07-02', value: a },
        ],
      },
      {
        server_id: SERVER_B,
        points: [
          { key: '2026-07-01', value: b },
          { key: '2026-07-02', value: b },
        ],
      },
    ],
    totals: [
      { key: '2026-07-01', value: a + b },
      { key: '2026-07-02', value: a + b },
    ],
    kpi: { avg: a + b, max: a + b, total: 2 * (a + b) },
  };
}

function emptySeries(): StatisticsSeries {
  return { by_server: [], totals: [], kpi: { avg: 0, max: 0, total: 0 } };
}

const FULL: StatisticsResponse = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-02T23:59:59.999Z',
  days: ['2026-07-01', '2026-07-02'],
  servers: [
    { server_id: SERVER_A, display_name: 'Main' },
    { server_id: SERVER_B, display_name: 'Second' },
  ],
  population: {
    avg_online: series(10, 5),
    peak_online: series(40, 12),
    avg_queue: series(2, 0),
    by_hour: series(1, 1),
    by_weekday: series(3, 1),
  },
  matches: {
    by_day: series(5, 2),
    modes: [
      { mode: 'AAS', matches: 8 },
      { mode: 'RAAS', matches: 5 },
    ],
    maps: [
      { map: 'Narva', matches: 7 },
      { map: 'Gorodok', matches: 3 },
    ],
  },
  community: {
    new_players: series(4, 1),
    chat_messages: series(120, 30),
    teamkills: series(3, 0),
  },
  moderation: {
    punishments: series(2, 1),
    avg_admins: series(1, 0),
    peak_admins: series(3, 1),
  },
};

// Exercises the "no data" arm of every conditional: no servers in the payload,
// empty daily series, no modes and no maps.
const EMPTY: StatisticsResponse = {
  ...FULL,
  servers: [],
  days: [],
  population: {
    avg_online: emptySeries(),
    peak_online: emptySeries(),
    avg_queue: emptySeries(),
    by_hour: emptySeries(),
    by_weekday: emptySeries(),
  },
  matches: { by_day: emptySeries(), modes: [], maps: [] },
  community: {
    new_players: emptySeries(),
    chat_messages: emptySeries(),
    teamkills: emptySeries(),
  },
  moderation: {
    punishments: emptySeries(),
    avg_admins: emptySeries(),
    peak_admins: emptySeries(),
  },
};

let statisticsResponse: { status: number; body: unknown } = { status: 200, body: FULL };
let serversResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    items: [
      { id: SERVER_A, display_name: 'Main' },
      { id: SERVER_B, display_name: 'Second' },
    ],
  },
};

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      if (url.startsWith('/api/v1/statistics')) {
        return Promise.resolve(
          new Response(JSON.stringify(statisticsResponse.body), {
            status: statisticsResponse.status,
          }),
        );
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(
          new Response(JSON.stringify(serversResponse.body), { status: serversResponse.status }),
        );
      }
      return Promise.resolve(new Response('nf', { status: 404 }));
    }),
  );
}

let createObjectURLMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  statisticsResponse = { status: 200, body: FULL };
  serversResponse = {
    status: 200,
    body: {
      items: [
        { id: SERVER_A, display_name: 'Main' },
        { id: SERVER_B, display_name: 'Second' },
      ],
    },
  };
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

describe('StatisticsBrowser — branch coverage', () => {
  it('renders every block once the post-mount range is set and data loads', async () => {
    await mount(<StatisticsBrowser />);
    expect(await screen.findByText('Население')).toBeInTheDocument();
    expect(screen.getByText('Матчи')).toBeInTheDocument();
    expect(screen.getByText('Сообщество')).toBeInTheDocument();
    expect(screen.getByText('Модерация')).toBeInTheDocument();
    expect(screen.getByText('Средний онлайн за день')).toBeInTheDocument();
    expect(screen.getByText('Онлайн по часам суток (UTC)')).toBeInTheDocument();
  });

  it('prints the Среднее / Максимум / Всего KPI strip for each series', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    // avg_online: per-server 10 and 5 over two days → stacked total 30.
    expect(screen.getAllByText(/Среднее 15 · Максимум 15 · Всего 30/).length).toBeGreaterThan(0);
  });

  it('renders the server legend from the payload', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    expect(screen.getAllByText('Main').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Second').length).toBeGreaterThan(0);
  });

  it('renders the ranked map bars', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Топ боевых карт');
    expect(screen.getByText('Narva')).toBeInTheDocument();
    expect(screen.getByText('Gorodok')).toBeInTheDocument();
  });

  it('falls back to the empty state for every chart when the payload is empty', async () => {
    statisticsResponse = { status: 200, body: EMPTY };
    await mount(<StatisticsBrowser />);
    expect(await screen.findByText('Ни один сервер не попал в выборку.')).toBeInTheDocument();
    // Every ChartCard, the modes doughnut and the ranked bars all fall back.
    expect(screen.getAllByText('Нет данных.').length).toBeGreaterThanOrEqual(10);
  });

  it('shows the error branch when the request fails (self-hide on 403)', async () => {
    statisticsResponse = { status: 403, body: { error: 'forbidden' } };
    await mount(<StatisticsBrowser />);
    expect(await screen.findByText('ошибка 403')).toBeInTheDocument();
    expect(screen.queryByText('Население')).not.toBeInTheDocument();
  });

  it('exports JSON when data is present', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the CSV link pointed at the same window as the loaded data', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    const csv = screen.getByRole('link', { name: 'CSV' });
    expect(csv.getAttribute('href')).toContain('format=csv');
    expect(csv.getAttribute('href')).toContain('/api/v1/statistics?from=');
  });

  it('opens the server dropdown and toggles a server on and off', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Все серверы' }));
    });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);

    await act(async () => {
      fireEvent.click(boxes[0] as HTMLElement);
    });
    expect(await screen.findByRole('button', { name: 'Серверов: 1' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    });
    expect(await screen.findByRole('button', { name: 'Все серверы' })).toBeInTheDocument();
  });

  it('renders the empty-dropdown branch when no server is available', async () => {
    serversResponse = { status: 200, body: { items: [] } };
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Все серверы' }));
    });
    expect(screen.getByText('Серверов нет.')).toBeInTheDocument();
  });

  it('tolerates a failing server list', async () => {
    serversResponse = { status: 500, body: {} };
    await mount(<StatisticsBrowser />);
    expect(await screen.findByText('Население')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Все серверы' }));
    });
    expect(screen.getByText('Серверов нет.')).toBeInTheDocument();
  });

  it('reveals the custom date inputs only for the custom preset', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    expect(screen.queryByLabelText('Начало периода')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Период'), { target: { value: 'custom' } });
    });
    expect(screen.getByLabelText('Начало периода')).toBeInTheDocument();
    expect(screen.getByLabelText('Конец периода')).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Начало периода'), {
        target: { value: '2026-07-01' },
      });
      fireEvent.change(screen.getByLabelText('Конец периода'), { target: { value: '2026-07-02' } });
    });
    expect(screen.getByRole('link', { name: 'CSV' }).getAttribute('href')).toContain(
      'from=2026-07-01T00%3A00%3A00.000Z',
    );
  });

  it('refetches with a single loading state when the preset changes', async () => {
    await mount(<StatisticsBrowser />);
    await screen.findByText('Население');
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
      String(call[0]).startsWith('/api/v1/statistics'),
    ).length;

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Период'), { target: { value: 'week' } });
    });

    const after = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
      String(call[0]).startsWith('/api/v1/statistics'),
    ).length;
    expect(after).toBe(before + 1);
  });
});
