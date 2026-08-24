// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAbsolute } from '@/components/ui';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/all-players'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: () => undefined,
}));

import PlayersPage from './page';

const FIRST_SEEN_A = '2024-01-02T03:04:05.000Z';
const FIRST_SEEN_B = '2024-02-03T04:05:06.000Z';
const FIRST_SEEN_C = '2024-03-04T05:06:07.000Z';

const PLAYERS_RESPONSE = {
  items: [
    {
      id: 'player-1',
      steam_id64: '76561197999270002',
      canonical_name: 'Alphazz',
      eos_id: 'eos-alpha',
      first_seen_at: FIRST_SEEN_A,
      last_seen_at: '2024-05-06T07:08:09.000Z',
      total_time_played_seconds: 400,
    },
    {
      id: 'player-2',
      steam_id64: '76561197999270003',
      canonical_name: 'Bravozz',
      eos_id: null,
      first_seen_at: FIRST_SEEN_B,
      last_seen_at: '2024-06-07T08:09:10.000Z',
      total_time_played_seconds: 0,
    },
    {
      id: 'player-3',
      steam_id64: null,
      canonical_name: 'Charliezz',
      eos_id: null,
      first_seen_at: FIRST_SEEN_C,
      last_seen_at: '2024-07-08T09:10:11.000Z',
      total_time_played_seconds: 7325,
    },
  ],
  total: 3,
};

const EMPTY_RESPONSE = { items: [], total: 0 };

const MARK_SUSPECT = {
  mark_type_id: 1,
  slug: 'cheater',
  label_en: 'Cheater',
  label_ru: 'Читер',
  icon: 'skull',
  severity: 5,
};

interface MockOptions {
  players?: typeof PLAYERS_RESPONSE;
  /** HTTP status for the list route; anything but 200 drives the error banner. */
  listStatus?: number;
  onlinePlayerIds?: string[];
  /** When false, the two side requests answer 500 so the page keeps its state. */
  sidecarsOk?: boolean;
  markSummary?: Array<{ player_id: string; marks: (typeof MARK_SUSPECT)[] }>;
}

/** Records every `/api/v1/players` list URL the page requests, in order. */
function mockFetch(opts: MockOptions = {}): {
  fetch: ReturnType<typeof vi.fn>;
  listUrls: string[];
} {
  const listUrls: string[] = [];
  const sidecarStatus = opts.sidecarsOk === false ? 500 : 200;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/players/online-status')) {
      return Promise.resolve(
        new Response(JSON.stringify({ online_player_ids: opts.onlinePlayerIds ?? [] }), {
          status: sidecarStatus,
        }),
      );
    }
    if (url.startsWith('/api/v1/players')) {
      listUrls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(opts.players ?? PLAYERS_RESPONSE), {
          status: opts.listStatus ?? 200,
        }),
      );
    }
    if (url.startsWith('/api/v1/marks/active-summary')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: opts.markSummary ?? [] }), { status: sidecarStatus }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fetch: fetchMock, listUrls };
}

async function renderPage(opts: MockOptions = {}): Promise<string[]> {
  const { fetch: fetchMock, listUrls } = mockFetch(opts);
  vi.stubGlobal('fetch', fetchMock);
  render(<PlayersPage />);
  await screen.findByText('Alphazz');
  return listUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlayersPage', () => {
  it('is a valid React component', () => {
    expect(PlayersPage).toBeDefined();
    expect(typeof PlayersPage).toBe('function');
  });

  it('requests sort=last_seen&dir=desc on the first load', async () => {
    const listUrls = await renderPage();
    expect(listUrls[0]).toBe('/api/v1/players?sort=last_seen&dir=desc');
  });

  it('renders the first-seen column under its Russian name', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: /^Создан/ })).toBeInTheDocument();
    expect(screen.getByText('Создан')).toBeInTheDocument();
    expect(screen.queryByText('Created')).not.toBeInTheDocument();
  });

  it('names the playtime and last-seen columns in Russian', async () => {
    await renderPage();
    expect(screen.getByText('Наиграно')).toBeInTheDocument();
    expect(screen.getByText('Был(а)')).toBeInTheDocument();
    expect(screen.queryByText('Total playtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Last seen')).not.toBeInTheDocument();
  });

  it('marks the sorted column with aria-sort and leaves the others unsorted', async () => {
    await renderPage();
    const sorted = screen.getByRole('button', { name: /^Был\(а\)/ }).closest('th');
    expect(sorted).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('button', { name: /^Ник/ }).closest('th')).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  /*
   * Ожидание строится через `formatAbsolute`, а не через `toLocaleString()`:
   * второй вариант печатал бы то же, что и страница до починки, и тест прошёл
   * бы на американском «1/2/2024, 3:04:05 AM» в русской панели.
   */
  it('renders the first_seen_at value in every body row, in the panel format', async () => {
    await renderPage();
    for (const iso of [FIRST_SEEN_A, FIRST_SEEN_B, FIRST_SEEN_C]) {
      const expected = formatAbsolute(iso, 'ru-RU') as string;
      expect(expected).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
      expect(screen.getByText(expected)).toBeInTheDocument();
    }
  });

  it('clicking the Ник header refetches with sort=nickname&dir=asc', async () => {
    const listUrls = await renderPage();
    await userEvent.click(screen.getByRole('button', { name: /^Ник/ }));
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/players?sort=nickname&dir=asc');
    });
  });

  it('clicking the Ник header twice refetches with sort=nickname&dir=desc', async () => {
    const listUrls = await renderPage();
    const header = screen.getByRole('button', { name: /^Ник/ });
    await userEvent.click(header);
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/players?sort=nickname&dir=asc');
    });
    await userEvent.click(header);
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/players?sort=nickname&dir=desc');
    });
  });

  it('clicking the Created header refetches with sort=created&dir=desc', async () => {
    const listUrls = await renderPage();
    await userEvent.click(screen.getByRole('button', { name: /^Создан/ }));
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/players?sort=created&dir=desc');
    });
  });

  it('ticking the new-players checkbox refetches with filter=new', async () => {
    const listUrls = await renderPage();
    await userEvent.click(screen.getByRole('checkbox', { name: 'новые (<7 дней)' }));
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/players?sort=last_seen&dir=desc&filter=new');
    });
  });

  it('renders formatted playtime for zero, sub-hour and multi-hour totals', async () => {
    await renderPage();
    expect(screen.getByText('6m')).toBeInTheDocument();
    expect(screen.getByText('0m')).toBeInTheDocument();
    expect(screen.getByText('2h 2m')).toBeInTheDocument();
  });

  it('renders a dash for a player without a SteamID64', async () => {
    await renderPage();
    const steamLinks = screen.getAllByRole('link', { name: /^76561197999/ });
    expect(steamLinks).toHaveLength(2);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the error banner when the list request fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ listStatus: 500 }).fetch);
    render(<PlayersPage />);
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });

  it('shows the empty-state message when no player has ever connected', async () => {
    vi.stubGlobal('fetch', mockFetch({ players: EMPTY_RESPONSE }).fetch);
    render(<PlayersPage />);
    expect(
      await screen.findByText(
        'Ни один игрок ещё не подключался. Запустите сервер и подключитесь в Squad-клиенте.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the no-matches message when the search box excludes every row', async () => {
    await renderPage();
    await userEvent.type(
      screen.getByPlaceholderText('Поиск по нику, SteamID или EOS ID…'),
      'zzzznomatch',
    );
    expect(await screen.findByText('Нет совпадений.')).toBeInTheDocument();
  });

  it('filters client-side by SteamID64 and by EOS ID', async () => {
    await renderPage();
    const box = screen.getByPlaceholderText('Поиск по нику, SteamID или EOS ID…');
    await userEvent.type(box, '76561197999270003');
    await waitFor(() => {
      expect(screen.queryByText('Alphazz')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Bravozz')).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, 'eos-alpha');
    await waitFor(() => {
      expect(screen.queryByText('Bravozz')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Alphazz')).toBeInTheDocument();
  });

  it('marks an online player and hides the offline ones behind только онлайн', async () => {
    await renderPage({ onlinePlayerIds: ['player-2'] });
    expect(await screen.findByText('сейчас на сервере')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'только онлайн' }));
    await waitFor(() => {
      expect(screen.queryByText('Alphazz')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Bravozz')).toBeInTheDocument();
  });

  it('cycles the Статус header between online-first, offline-first and unsorted', async () => {
    await renderPage({ onlinePlayerIds: ['player-2'] });
    const statusHeader = screen.getByRole('button', { name: /^Статус/ });
    const names = () => screen.getAllByRole('link', { name: /zz$/ }).map((a) => a.textContent);

    await userEvent.click(statusHeader);
    await waitFor(() => expect(names()[0]).toBe('Bravozz'));

    await userEvent.click(statusHeader);
    await waitFor(() => expect(names()[0]).toBe('Alphazz'));

    await userEvent.click(statusHeader);
    await waitFor(() => expect(names()).toEqual(['Alphazz', 'Bravozz', 'Charliezz']));
  });

  /**
   * The tint is a colour-only cue, so it is not what the test may assert:
   * the row has to *say* the player carries a mark. That is the badge in the
   * nickname cell, and only the marked row gets one.
   */
  it('marks the row of a player carrying an active mark', async () => {
    await renderPage({ markSummary: [{ player_id: 'player-1', marks: [MARK_SUSPECT] }] });

    const markedRow = await waitFor(() => {
      const row = screen.getByText('Alphazz').closest('tr');
      if (!row || within(row).queryByText('метка') === null) {
        throw new Error('mark badge not rendered yet');
      }
      return row;
    });
    expect(within(markedRow).getByTitle('Читер')).toBeInTheDocument();

    const plainRow = screen.getByText('Bravozz').closest('tr');
    expect(plainRow).not.toBeNull();
    expect(within(plainRow as HTMLElement).queryByText('метка')).toBeNull();
  });

  it('keeps rendering when the marks and online-status requests fail', async () => {
    await renderPage({ sidecarsOk: false });
    expect(screen.getByText('Alphazz')).toBeInTheDocument();
    expect(screen.queryByText('сейчас на сервере')).not.toBeInTheDocument();
  });
});
