// @vitest-environment happy-dom
// LEAD-7 (#178): the period rail's season mode — a picker over real named
// seasons, replacing the calendar-year placeholder, with closed/finalized
// seasons offered read-only.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/leaderboards'),
  useRouter: vi.fn(() => ({ replace, push })),
  useSearchParams: vi.fn(() => currentParams),
}));

import { LeaderboardsBrowser } from './LeaderboardsBrowser';

const TEST_TIMEOUT_MS = 15_000;

const ACTIVE_SEASON = {
  id: 'season-live',
  name: 'Лето 2026',
  starts_at: '2026-06-01T00:00:00.000Z',
  ends_at: '2026-08-31T00:00:00.000Z',
  status: 'active' as const,
  finalized: false,
};

const CLOSED_SEASON = {
  id: 'season-old',
  name: 'Зима 2025',
  starts_at: '2025-12-01T00:00:00.000Z',
  ends_at: '2026-02-28T00:00:00.000Z',
  status: 'closed' as const,
  finalized: true,
};

function emptyLeaderboard(overrides: Record<string, unknown> = {}) {
  return {
    metric: 'online',
    period: 'alltime',
    period_start: '1970-01-01',
    season: null,
    server_id: null,
    available: true,
    combat_available: true,
    economy_enabled: false,
    total_rows: 0,
    total_pages: 1,
    rows: [],
    ...overrides,
  };
}

function stubFetch(
  opts: { seasons?: unknown[]; seasonsStatus?: number; leaderboard?: Record<string, unknown> } = {},
): {
  fn: ReturnType<typeof vi.fn>;
  calls: string[];
} {
  const seasons = opts.seasons ?? [ACTIVE_SEASON, CLOSED_SEASON];
  const seasonsStatus = opts.seasonsStatus ?? 200;
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/v1/seasons')) {
      return Promise.resolve(
        new Response(
          seasonsStatus === 200 ? JSON.stringify({ items: seasons }) : JSON.stringify({}),
          { status: seasonsStatus },
        ),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(emptyLeaderboard(opts.leaderboard)), { status: 200 }),
    );
  });
  return { fn, calls };
}

async function renderWith(
  params: string,
  opts: { seasons?: unknown[]; seasonsStatus?: number; leaderboard?: Record<string, unknown> } = {},
): Promise<{ calls: string[] }> {
  currentParams = new URLSearchParams(params);
  const stub = stubFetch(opts);
  vi.stubGlobal('fetch', stub.fn);
  render(<LeaderboardsBrowser />);
  await waitFor(() => expect(stub.calls.some((u) => u.startsWith('/api/v1/seasons'))).toBe(true));
  return { calls: stub.calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  push.mockReset();
});

describe('LeaderboardsBrowser season selector', () => {
  it(
    'shows no season picker while another period is selected',
    async () => {
      await renderWith('');
      expect(screen.queryByLabelText('Сезон')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lists every season, marking the closed one as an archive entry',
    async () => {
      await renderWith('period=season&start=2026-06-01');

      const picker = await screen.findByLabelText('Сезон');
      const options = Array.from(picker.querySelectorAll('option')).map((o) => o.textContent);
      // Newest first, and the frozen season is flagged read-only.
      expect(options).toEqual(['Лето 2026', 'Зима 2025 (архив)']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'labels the running season with its date range and no read-only note',
    async () => {
      await renderWith('period=season&start=2026-06-01');

      await screen.findByLabelText('Сезон');
      expect(screen.getByText(/01\.06\.2026/)).toBeInTheDocument();
      expect(screen.queryByText(/только просмотр/)).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'selects the season the API resolved when the URL carries period=season without start (#573)',
    async () => {
      await renderWith('period=season', {
        leaderboard: { period: 'season', period_start: '2026-06-01', season: ACTIVE_SEASON },
      });

      const picker = (await screen.findByLabelText('Сезон')) as HTMLSelectElement;
      await waitFor(() => expect(picker.value).toBe('2026-06-01'));
      expect(screen.getByText(/01\.06\.2026/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'marks a closed season as view-only when it is the selected one',
    async () => {
      await renderWith('period=season&start=2025-12-01');

      await screen.findByLabelText('Сезон');
      expect(screen.getByText(/только просмотр/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never offers the prev/next arrows for seasons',
    async () => {
      await renderWith('period=season&start=2026-06-01');

      await screen.findByLabelText('Сезон');
      expect(screen.queryByLabelText('Предыдущий период')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Следующий период')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still offers the arrows for a day period',
    async () => {
      await renderWith('period=day&start=2026-07-05');

      expect(await screen.findByLabelText('Предыдущий период')).toBeInTheDocument();
      expect(screen.queryByLabelText('Сезон')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'switching season pushes the new period_start into the URL',
    async () => {
      await renderWith('period=season&start=2026-06-01');

      const picker = await screen.findByLabelText('Сезон');
      fireEvent.change(picker, { target: { value: '2025-12-01' } });

      await waitFor(() => expect(replace).toHaveBeenCalled());
      expect(replace.mock.calls.at(-1)?.[0]).toContain('start=2025-12-01');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'requests the leaderboard with the season period_start',
    async () => {
      const { calls } = await renderWith('period=season&start=2026-06-01');

      await waitFor(() => expect(calls.some((u) => u.includes('period=season'))).toBe(true));
      const leaderboardCall = calls.find((u) => u.startsWith('/api/v1/leaderboards'));
      expect(leaderboardCall).toContain('period_start=2026-06-01');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports that no seasons exist rather than rendering an empty picker',
    async () => {
      await renderWith('period=season', { seasons: [] });

      expect(await screen.findByText('Сезоны не заданы.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Сезон')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'degrades to the empty state when the season list is forbidden',
    async () => {
      await renderWith('period=season', { seasonsStatus: 403 });

      expect(await screen.findByText('Сезоны не заданы.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ignores a malformed /api/v1/seasons response instead of crashing',
    async () => {
      currentParams = new URLSearchParams('period=season');
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons')) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: 'not an array' }), {
              status: 200,
            }),
          );
        }
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: 'not an array' }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify(emptyLeaderboard()), { status: 200 }));
      });
      vi.stubGlobal('fetch', fn);
      render(<LeaderboardsBrowser />);

      expect(await screen.findByText('Сезоны не заданы.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('LeaderboardsBrowser combat metrics banner', () => {
  it(
    'does not show the combat-unavailable banner before the first load resolves',
    async () => {
      currentParams = new URLSearchParams('');
      let resolveLeaderboard: (value: Response) => void = () => {};
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return new Promise<Response>((resolve) => {
          resolveLeaderboard = resolve;
        });
      });
      vi.stubGlobal('fetch', fn);
      render(<LeaderboardsBrowser />);

      expect(screen.queryByText('Боевые метрики пока недоступны')).not.toBeInTheDocument();
      resolveLeaderboard(new Response(JSON.stringify(emptyLeaderboard()), { status: 200 }));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the combat banner hidden after a failed load, instead of defaulting to unavailable',
    async () => {
      currentParams = new URLSearchParams('');
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Ой.' } }), {
            status: 500,
          }),
        );
      });
      vi.stubGlobal('fetch', fn);
      render(<LeaderboardsBrowser />);

      expect(await screen.findByText('Ой.')).toBeInTheDocument();
      expect(screen.queryByText('Боевые метрики пока недоступны')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('LeaderboardsBrowser error handling', () => {
  it(
    'surfaces the API Russian error message instead of a bare HTTP status',
    async () => {
      currentParams = new URLSearchParams('');
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'internal_error', message: 'Не удалось загрузить таблицу лидеров.' },
            }),
            { status: 500 },
          ),
        );
      });
      vi.stubGlobal('fetch', fn);
      render(<LeaderboardsBrowser />);

      expect(await screen.findByText('Не удалось загрузить таблицу лидеров.')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'clears stale rows once a filter change reload fails',
    async () => {
      currentParams = new URLSearchParams('');
      let call = 0;
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons') || url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                emptyLeaderboard({
                  total_rows: 1,
                  rows: [
                    {
                      rank: 1,
                      player_id: 'p1',
                      current_name: 'Игрок1',
                      steam_id64: null,
                      eos_id: null,
                      metric_value: 10,
                      secondary: {
                        online_seconds: 10,
                        seeding_seconds: 0,
                        kills: 0,
                        deaths: 0,
                        kd: 0,
                        matches_played: 1,
                      },
                    },
                  ],
                }),
              ),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
      });
      vi.stubGlobal('fetch', fn);
      const { rerender } = render(<LeaderboardsBrowser />);

      expect(await screen.findByRole('link', { name: 'Игрок1' })).toBeInTheDocument();

      // Simulate the URL changing (e.g. a filter edit): a fresh search params
      // object makes `filters` recompute and the load effect refire.
      currentParams = new URLSearchParams('server=srv-1');
      rerender(<LeaderboardsBrowser />);

      await waitFor(() => expect(screen.queryByRole('link', { name: 'Игрок1' })).toBeNull());
    },
    TEST_TIMEOUT_MS,
  );
});

/*
 * LEAD-572: metricValue() had no 'revives' case and fell through to
 * `default: row.metric_value` — whichever metric the table is currently
 * sorted by — so the "Возрождения" column showed the sort metric's value
 * instead of the actual revive count.
 */
describe('LeaderboardsBrowser — LEAD-572 колонка «Возрождения»', () => {
  it(
    'показывает число возрождений, а не значение метрики сортировки',
    async () => {
      currentParams = new URLSearchParams(); // default sort: metric=online
      const row = {
        rank: 1,
        player_id: 'p1',
        current_name: 'Игрок1',
        steam_id64: null,
        eos_id: null,
        metric_value: 12345, // the online-seconds sort value
        secondary: {
          online_seconds: 12345,
          seeding_seconds: 0,
          kills: 10,
          deaths: 2,
          revives: 7,
          teamkills: 0,
          kd: 5,
          matches_played: 3,
        },
      };
      const fn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/seasons')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify(emptyLeaderboard({ rows: [row], total_rows: 1 })), {
            status: 200,
          }),
        );
      });
      vi.stubGlobal('fetch', fn);
      render(<LeaderboardsBrowser />);

      await screen.findByText('Игрок1');
      const table = screen.getByRole('table');
      const revivesColIndex = Array.from(table.querySelectorAll('th')).findIndex((th) =>
        th.textContent?.includes('Возрождения'),
      );
      expect(revivesColIndex).toBeGreaterThan(-1);
      const dataRow = table.querySelectorAll('tbody tr')[0];
      const cell = dataRow?.querySelectorAll('td')[revivesColIndex];
      expect(cell?.textContent).toBe('7');
    },
    TEST_TIMEOUT_MS,
  );
});
