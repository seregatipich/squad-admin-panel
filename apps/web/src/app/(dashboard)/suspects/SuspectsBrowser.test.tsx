// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuspectsBrowser } from './SuspectsBrowser';

const MARK_TYPES = [
  {
    id: 1,
    slug: 'cheater',
    label_en: 'Cheater',
    label_ru: 'Читер',
    icon: 'skull',
    severity: 5,
    sort_order: 1,
  },
];

const SUSPECT = {
  id: 'player-1',
  steam_id64: '76561197999270002',
  eos_id: null,
  canonical_name: 'Alphazz',
  last_seen_at: '2026-05-06T07:08:09.000Z',
  role: null,
  marks: [
    {
      mark_type_id: 1,
      slug: 'cheater',
      label_en: 'Cheater',
      label_ru: 'Читер',
      icon: 'skull',
      severity: 5,
    },
  ],
  has_active_ban: true,
};

const CLEAN_SUSPECT = {
  ...SUSPECT,
  id: 'player-2',
  canonical_name: 'Bravozz',
  has_active_ban: false,
};

interface MockOptions {
  items?: unknown[];
  /** Anything but 200 on the list route drives the error banner. */
  listStatus?: number;
  nextCursor?: string | null;
}

/** Records every `/api/v1/suspects` URL the browser requests, in order. */
function mockFetch(opts: MockOptions = {}): string[] {
  const listUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/v1/mark-types')) {
        return Promise.resolve(new Response(JSON.stringify(MARK_TYPES), { status: 200 }));
      }
      if (url.startsWith('/api/v1/suspects')) {
        listUrls.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: opts.items ?? [SUSPECT, CLEAN_SUSPECT],
              next_cursor: opts.nextCursor ?? null,
            }),
            { status: opts.listStatus ?? 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return listUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SuspectsBrowser', () => {
  it('lists suspects in a table whose columns are named in Russian', async () => {
    mockFetch();
    render(<SuspectsBrowser />);

    const table = await screen.findByRole('table', { name: 'Игроки с активными метками' });
    for (const header of ['Игрок', 'Метки', 'Последний визит', 'Бан']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(within(table).getByRole('link', { name: 'Alphazz' })).toHaveAttribute(
      'href',
      '/all-players/player-1',
    );
  });

  it('states the ban in words, and only on the banned row', async () => {
    mockFetch();
    render(<SuspectsBrowser />);

    const banned = (await screen.findByText('Alphazz')).closest('tr');
    expect(banned).not.toBeNull();
    expect(within(banned as HTMLElement).getByText('забанен')).toBeInTheDocument();

    const clean = screen.getByText('Bravozz').closest('tr');
    expect(within(clean as HTMLElement).queryByText('забанен')).toBeNull();
  });

  it('offers a retry when the list request fails', async () => {
    const listUrls = mockFetch({ listStatus: 500 });
    render(<SuspectsBrowser />);

    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText('HTTP 500')).toBeInTheDocument();

    const before = listUrls.length;
    fireEvent.click(within(banner).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(listUrls.length).toBeGreaterThan(before));
  });

  it('reports mark-type filter state with aria-pressed and narrows the query', async () => {
    const listUrls = mockFetch();
    render(<SuspectsBrowser />);

    const chip = await screen.findByRole('button', { name: /Читер/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => {
      expect(listUrls).toContain('/api/v1/suspects?mark_type_ids=1');
    });
  });

  it('explains an empty list instead of showing an empty table', async () => {
    mockFetch({ items: [] });
    render(<SuspectsBrowser />);

    expect(await screen.findByText('Подозреваемых не найдено.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
