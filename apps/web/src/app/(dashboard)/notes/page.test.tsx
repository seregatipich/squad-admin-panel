// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/notes'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import NotesFeedPage from './page';

const NOTE = {
  id: 'note-1',
  player_id: 'player-1',
  target: { id: 'player-1', name: 'Целевой' },
  author: { id: 'admin-1', name: 'Админ', role_color: null, role_name: null },
  body: 'Короткая заметка',
  created_at: new Date('2026-01-02T03:04:05Z').toISOString(),
  updated_at: null,
  edited: false,
  deleted: false,
  deleted_at: null,
  deleted_by: null,
};

/** Лента и список авторов приходят разными запросами — стаб различает их по URL. */
function stubFetch(feed: { items: unknown[]; next_cursor: string | null }, ok = true) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/v1/notes/authors')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (!ok) return Promise.resolve(new Response('', { status: 500 }));
    return Promise.resolve(
      new Response(JSON.stringify({ ...feed, can_view_deleted: false }), { status: 200 }),
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotesFeedPage', () => {
  it('is a valid React component', () => {
    expect(NotesFeedPage).toBeDefined();
    expect(typeof NotesFeedPage).toBe('function');
  });

  it('renders the feed table with a link to the player card', async () => {
    vi.stubGlobal('fetch', stubFetch({ items: [NOTE], next_cursor: null }));
    render(<NotesFeedPage />);

    expect(await screen.findByRole('table', { name: 'Лента заметок админов' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Целевой' })).toHaveAttribute(
      'href',
      '/all-players/player-1#notes',
    );
  });

  it('tells an empty feed apart from an empty filter result', async () => {
    vi.stubGlobal('fetch', stubFetch({ items: [], next_cursor: null }));
    render(<NotesFeedPage />);

    const empty = await screen.findByText('Заметок пока нет');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
  });

  it('does not re-fetch the feed when can_view_deleted flips to true after the first load', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/notes/authors')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items: [NOTE], next_cursor: null, can_view_deleted: true }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotesFeedPage />);

    await screen.findByRole('table', { name: 'Лента заметок админов' });
    // Reveals the "Показывать удалённые" checkbox once can_view_deleted comes
    // back true, proving the privileged branch actually ran.
    await screen.findByLabelText('Показывать удалённые');

    const feedRequests = fetchMock.mock.calls.filter(
      (call) => !String(call[0]).startsWith('/api/v1/notes/authors'),
    );
    expect(feedRequests).toHaveLength(1);
  });

  it('offers a retry when the feed request fails', async () => {
    const fetchMock = stubFetch({ items: [], next_cursor: null }, false);
    vi.stubGlobal('fetch', fetchMock);
    render(<NotesFeedPage />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось загрузить заметки');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('exposes the CSV export as a real control', async () => {
    vi.stubGlobal('fetch', stubFetch({ items: [NOTE], next_cursor: null }));
    render(<NotesFeedPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Экспорт CSV' })).toBeEnabled());
  });

  it('sends explicit UTC-offset day boundaries for the date filters', async () => {
    const fetchMock = stubFetch({ items: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotesFeedPage />);
    await screen.findByText('Заметок пока нет');

    const user = userEvent.setup();
    fetchMock.mockClear();
    await user.type(screen.getByLabelText('С даты'), '2026-01-05');
    await user.type(screen.getByLabelText('По дату'), '2026-01-05');

    await waitFor(() => {
      const feedCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/api/v1/notes?'),
      );
      const last = feedCalls.at(-1);
      const url = last ? new URL(String(last[0]), 'http://localhost') : null;
      expect(url?.searchParams.get('dateFrom')).toBeTruthy();
      expect(url?.searchParams.get('dateTo')).toBeTruthy();
    });
    const lastFeedCall = fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/api/v1/notes?'))
      .at(-1);
    const url = new URL(String(lastFeedCall?.[0]), 'http://localhost');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    expect(dateFrom).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(dateTo).toMatch(/T\d{2}:\d{2}:59\.999Z$/);
    // Both must carry an explicit UTC offset (the trailing Z from toISOString),
    // unlike the old `${dateFrom}T00:00:00` string the API parsed in its own
    // timezone.
    expect(new Date(dateFrom as string).getHours()).toBe(
      new Date('2026-01-05T00:00:00').getHours(),
    );
  });

  it('does not fire a request on every keystroke in the player filter', async () => {
    const fetchMock = stubFetch({ items: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotesFeedPage />);
    await screen.findByText('Заметок пока нет');

    const user = userEvent.setup({ delay: null });
    fetchMock.mockClear();
    const playerField = screen.getByLabelText('Игрок');
    await user.type(playerField, 'abc');

    // The debounced field must not have committed a fetch per keystroke yet.
    const feedCallsDuringTyping = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/api/v1/notes?'),
    );
    expect(feedCallsDuringTyping.length).toBe(0);
  });

  it('discards a stale in-flight response when filters change before it resolves', async () => {
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const staleNote = { ...NOTE, id: 'stale-note', target: { id: 'p2', name: 'Устаревший' } };
    const freshNote = { ...NOTE, id: 'fresh-note', target: { id: 'p3', name: 'Свежий' } };

    let feedCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/notes/authors')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      feedCallCount += 1;
      if (feedCallCount === 1) return firstResponse;
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: [freshNote], next_cursor: null, can_view_deleted: false }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NotesFeedPage />);
    await waitFor(() => expect(feedCallCount).toBe(1));

    const user = userEvent.setup({ delay: null });
    // Commit a new query while the first request is still pending: the second
    // request should win even if the first resolves afterwards.
    await user.type(screen.getByLabelText('Поиск по тексту'), 'x{Enter}');
    await waitFor(() => expect(feedCallCount).toBe(2));

    resolveFirst(
      new Response(
        JSON.stringify({ items: [staleNote], next_cursor: null, can_view_deleted: false }),
        {
          status: 200,
        },
      ),
    );

    await screen.findByText('Свежий');
    expect(screen.queryByText('Устаревший')).not.toBeInTheDocument();
  });
});
