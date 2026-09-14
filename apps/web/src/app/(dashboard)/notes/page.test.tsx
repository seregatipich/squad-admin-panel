// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
});
