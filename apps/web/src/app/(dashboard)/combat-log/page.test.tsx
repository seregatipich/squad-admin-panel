// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace })),
  usePathname: vi.fn(() => '/combat-log'),
  useSearchParams: vi.fn(() => currentSearchParams),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import CombatLogPage from './page';

const DEATH_ROW = {
  id: 1,
  eventType: 'death',
  serverId: 'srv-1',
  matchId: null,
  weapon: 'BP_AK74',
  damage: null,
  attackerKit: null,
  isTeamkill: false,
  occurredAt: '2026-09-25T10:00:00.000Z',
  attacker: { player_id: 'p-attacker', current_name: 'Стрелок' },
  victim: { player_id: 'p-victim', current_name: 'Жертва' },
};

const TEAMKILL_ROW = {
  ...DEATH_ROW,
  id: 2,
  isTeamkill: true,
  weapon: 'BP_M4A1',
  attacker: { player_id: 'p-tk', current_name: 'Тимкиллер' },
};

interface Options {
  rows?: unknown[];
  nextCursor?: string | null;
  status?: number;
}

function stubFetch(opts: Options = {}): string[] {
  const eventUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/combat-events')) {
        eventUrls.push(url);
        const rows = opts.rows ?? [DEATH_ROW];
        return Promise.resolve(
          new Response(
            JSON.stringify({ rows, nextCursor: opts.nextCursor ?? null, approxTotal: rows.length }),
            { status: opts.status ?? 200 },
          ),
        );
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return eventUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
  currentSearchParams = new URLSearchParams();
});

describe('CombatLogPage', () => {
  it('owns the single page heading and shows a skeleton while loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<CombatLogPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Боевой лог' })).toBeInTheDocument();
    expect(await screen.findByText('Загрузка боевого лога')).toBeInTheDocument();
  });

  it('lists the kill with attacker, victim and weapon, asking for kills only by default', async () => {
    const urls = stubFetch();
    render(<CombatLogPage />);

    const table = await screen.findByRole('table', { name: 'Боевые события' });
    expect(within(table).getByRole('link', { name: 'Стрелок' })).toHaveAttribute(
      'href',
      '/all-players/p-attacker',
    );
    expect(within(table).getByRole('link', { name: 'Жертва' })).toHaveAttribute(
      'href',
      '/all-players/p-victim',
    );
    expect(within(table).getByText('BP_AK74')).toBeInTheDocument();
    expect(within(table).getByText('Смерть')).toBeInTheDocument();

    const query = new URL(urls[0] as string, 'http://test').searchParams;
    expect(query.getAll('type')).toEqual(['death']);
    expect(query.get('excludeTeamkills')).toBe('true');
    expect(screen.getByText('Больше событий нет')).toBeInTheDocument();
  });

  it('badges a teamkill with TK', async () => {
    stubFetch({ rows: [TEAMKILL_ROW] });
    render(<CombatLogPage />);

    const table = await screen.findByRole('table', { name: 'Боевые события' });
    expect(within(table).getByTitle('Тимкилл')).toHaveTextContent('TK');
  });

  it('shows the empty state when nothing has been recorded', async () => {
    stubFetch({ rows: [] });
    render(<CombatLogPage />);

    expect(await screen.findByText('Боевых событий пока нет')).toBeInTheDocument();
  });

  it('tells an empty filter result apart from an empty log and resets the filters', async () => {
    currentSearchParams = new URLSearchParams('preset=today');
    stubFetch({ rows: [] });
    render(<CombatLogPage />);

    expect(await screen.findByText('Нет совпадений.')).toBeInTheDocument();

    await userEvent.click(
      screen.getAllByRole('button', { name: 'Сбросить фильтры' })[0] as HTMLElement,
    );

    expect(replace).toHaveBeenCalledWith('/combat-log');
  });

  it('shows an error banner with a retry when the request fails', async () => {
    stubFetch({ status: 500 });
    render(<CombatLogPage />);

    expect(await screen.findByText('Не удалось загрузить боевой лог')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('puts the chosen event type into the URL', async () => {
    stubFetch();
    render(<CombatLogPage />);
    await screen.findByRole('table', { name: 'Боевые события' });

    await userEvent.click(screen.getByRole('tab', { name: 'Тимкиллы' }));

    expect(replace).toHaveBeenCalledWith('/combat-log?facet=teamkills');
  });

  it('asks for teamkills only when the facet comes from the URL', async () => {
    currentSearchParams = new URLSearchParams('facet=teamkills');
    const urls = stubFetch({ rows: [TEAMKILL_ROW] });
    render(<CombatLogPage />);

    await screen.findByRole('table', { name: 'Боевые события' });
    expect(new URL(urls[0] as string, 'http://test').searchParams.get('teamkillsOnly')).toBe(
      'true',
    );
  });
});
