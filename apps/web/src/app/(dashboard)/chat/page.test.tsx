// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  usePathname: vi.fn(() => '/chat'),
  useSearchParams: vi.fn(() => currentSearchParams),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import ChatPage from './page';

function message(id: number, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    serverId: 'srv-1',
    scope: 'all',
    message: text,
    source: 'chat',
    isFlagged: false,
    teamId: null,
    squadId: null,
    sentAt: '2026-04-23T11:30:20.485Z',
    player: { id: `player-${id}`, nickname: `Игрок${id}` },
    ...overrides,
  };
}

interface Options {
  firstPage?: { items: unknown[]; next_cursor: string | null };
  secondPage?: { items: unknown[]; next_cursor: string | null };
  messagesStatus?: number;
  canBan?: boolean;
}

function stubFetch(opts: Options = {}): string[] {
  const messageUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/chat/messages')) {
        messageUrls.push(url);
        const isNextPage = new URL(url, 'http://test').searchParams.has('cursor');
        const page = isNextPage
          ? (opts.secondPage ?? { items: [], next_cursor: null })
          : (opts.firstPage ?? { items: [message(1, 'привет всем')], next_cursor: null });
        return Promise.resolve(
          new Response(JSON.stringify(page), { status: opts.messagesStatus ?? 200 }),
        );
      }
      if (url.startsWith('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      }
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ squad_permissions: opts.canBan ? ['ban'] : [] })),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return messageUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  currentSearchParams = new URLSearchParams();
});

describe('ChatPage', () => {
  it('shows the loading skeleton until the archive arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<ChatPage />);

    expect(await screen.findByText('Загружаем архив чата')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders the message with its author linked to the player card', async () => {
    stubFetch();
    render(<ChatPage />);

    const table = await screen.findByRole('table', { name: 'Сообщения чата' });
    expect(within(table).getByText('привет всем')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Игрок1' })).toHaveAttribute(
      'href',
      '/all-players/player-1',
    );
    expect(screen.getByText('Показано 1')).toBeInTheDocument();
  });

  it('marks a message caught by the chat filter', async () => {
    stubFetch({
      firstPage: { items: [message(1, 'плохое слово', { isFlagged: true })], next_cursor: null },
    });
    render(<ChatPage />);

    expect(await screen.findByText('флаг')).toBeInTheDocument();
  });

  it('shows the empty state when nobody has written yet', async () => {
    stubFetch({ firstPage: { items: [], next_cursor: null } });
    render(<ChatPage />);

    expect(await screen.findByText('Сообщений пока нет')).toBeInTheDocument();
  });

  it('tells an empty search result apart from an empty archive', async () => {
    currentSearchParams = new URLSearchParams('text=ничего');
    const urls = stubFetch({ firstPage: { items: [], next_cursor: null } });
    render(<ChatPage />);

    expect(await screen.findByText('Ничего не нашлось')).toBeInTheDocument();
    expect(new URL(urls[0] as string, 'http://test').searchParams.get('text')).toBe('ничего');
  });

  it('shows an error banner when the archive request fails', async () => {
    stubFetch({ messagesStatus: 500 });
    render(<ChatPage />);

    expect(await screen.findByText('Не удалось загрузить чат')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('appends the next page after the cursor when "Показать ещё" is pressed', async () => {
    const urls = stubFetch({
      firstPage: { items: [message(1, 'первое')], next_cursor: 'cursor-1' },
      secondPage: { items: [message(2, 'второе')], next_cursor: null },
    });
    render(<ChatPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));

    expect(await screen.findByText('второе')).toBeInTheDocument();
    expect(screen.getByText('первое')).toBeInTheDocument();
    expect(new URL(urls[1] as string, 'http://test').searchParams.get('cursor')).toBe('cursor-1');
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('offers the nickname ban only with the ban squad permission', async () => {
    stubFetch({ canBan: true });
    render(<ChatPage />);

    expect(await screen.findByRole('button', { name: /забанить ник/i })).toBeInTheDocument();
  });
});
