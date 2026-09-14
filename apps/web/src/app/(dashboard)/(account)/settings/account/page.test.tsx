// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/account'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));
// Оба блока статистики ходят в свои маршруты и покрыты собственными тестами;
// здесь проверяется только то, что страница отдаёт им нужного игрока.
// Идентификатор проверяется атрибутом, а не текстом: страница обязана нигде
// не печатать uuid игрока, и на этом стоит соседний тест.
vi.mock('@/components/DossierSection', () => ({
  DossierSection: ({
    playerId,
    title,
    serverFilter = true,
  }: {
    playerId: string;
    title?: string;
    serverFilter?: boolean;
  }) => (
    <div
      data-testid="dossier"
      data-player-id={playerId}
      data-title={title ?? 'Досье'}
      data-server-filter={String(serverFilter)}
    />
  ),
}));
vi.mock('@/components/RecentMatchesSection', () => ({
  RecentMatchesSection: ({ playerId }: { playerId: string }) => (
    <div data-testid="recent-matches" data-player-id={playerId} />
  ),
}));

import AccountPage from './page';

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`,
 * а подтверждение завершения сессии построено на примитиве `Modal`. Полифилл
 * повторяет ровно то, на что опирается примитив: атрибут `open`, фокус внутрь
 * окна и цепочку Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

const ME = {
  player_id: 'player-1',
  steam_id64: '76561198000000001',
  canonical_name: 'Alpha',
  avatar_url: null,
  permissions: ['role:view', 'user:view'],
};

const NAMES = {
  canonical_name: 'Alpha',
  persona_name: 'AlphaOnSteam',
  history: [
    {
      name: 'Alpha',
      first_seen_at: '2026-06-01T00:00:00.000Z',
      last_seen_at: '2026-08-01T00:00:00.000Z',
    },
    {
      name: 'AlphaOld',
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-06-01T00:00:00.000Z',
    },
  ],
};

const SESSIONS = [
  {
    id: 'sess-current',
    ip: '10.0.0.1',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    last_activity_at: '2026-07-24T10:00:00.000Z',
    expires_at: '2126-07-24T10:00:00.000Z',
    current: true,
  },
  {
    id: 'sess-other',
    ip: null,
    user_agent: null,
    last_activity_at: '2026-07-23T10:00:00.000Z',
    expires_at: '2126-07-23T10:00:00.000Z',
    current: false,
  },
];

interface FetchOptions {
  meStatus?: number;
  sessionsStatus?: number;
  deleteStatus?: number;
}

function installFetch(options: FetchOptions = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE') {
      return Promise.resolve(new Response('{}', { status: options.deleteStatus ?? 200 }));
    }
    if (url === '/api/v1/me') {
      const status = options.meStatus ?? 200;
      return Promise.resolve(new Response(status === 200 ? JSON.stringify(ME) : 'no', { status }));
    }
    if (url === '/api/v1/me/sessions') {
      const status = options.sessionsStatus ?? 200;
      return Promise.resolve(
        new Response(status === 200 ? JSON.stringify(SESSIONS) : 'no', { status }),
      );
    }
    if (url === '/api/v1/me/names') {
      return Promise.resolve(new Response(JSON.stringify(NAMES), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(options: FetchOptions = {}) {
  const fetchMock = installFetch(options);
  await act(async () => {
    render(<AccountPage />);
  });
  return fetchMock;
}

function deleteCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'DELETE',
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AccountPage', () => {
  it('shows the profile with the permission count declined in Russian', async () => {
    await renderPage();
    expect(await screen.findByText('76561198000000001')).toBeInTheDocument();
    expect(screen.getByText('Права')).toBeInTheDocument();
    expect(screen.getByText('2 ключа')).toBeInTheDocument();
    expect(screen.queryByText('Permissions')).not.toBeInTheDocument();
  });

  it('names the account in the header instead of in a profile row', async () => {
    await renderPage();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ещё 1 ник' })).toBeInTheDocument();
    // Строки «Идентификатор игрока» и «Имя» убраны: внутренний UUID оператору
    // ничего не даёт, а имя переехало в шапку.
    expect(screen.queryByText('Идентификатор игрока')).not.toBeInTheDocument();
    expect(screen.queryByText('Имя')).not.toBeInTheDocument();
    expect(screen.queryByText('player-1')).not.toBeInTheDocument();
  });

  it('does not repeat the logout that already lives in the top navigation', async () => {
    await renderPage();
    await screen.findByText('10.0.0.1');
    expect(screen.queryByRole('button', { name: 'Выйти' })).not.toBeInTheDocument();
    expect(screen.queryByText('Выйти из панели')).not.toBeInTheDocument();
  });

  it('marks the current session and offers to end only the others', async () => {
    await renderPage();
    await screen.findByText('10.0.0.1');
    expect(screen.getByText('текущая')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Завершить' })).toHaveLength(1);
  });

  it('asks for confirmation before ending a single session', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('10.0.0.1');

    fireEvent.click(screen.getByRole('button', { name: 'Завершить' }));

    const dialog = await screen.findByRole('dialog', { name: 'Завершить сессию' });
    expect(deleteCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Завершить сессию' }));
    });

    const calls = deleteCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe('/api/v1/me/sessions/sess-other');
    expect(await screen.findByText('Сессия завершена.')).toBeInTheDocument();
  });

  it('ends nothing when the confirmation is dismissed', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('10.0.0.1');

    fireEvent.click(screen.getByRole('button', { name: 'Завершить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Завершить сессию' });
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0]);
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('asks for confirmation before ending every session', async () => {
    const fetchMock = await renderPage();
    await screen.findByText('10.0.0.1');

    fireEvent.click(screen.getByRole('button', { name: 'Завершить все' }));
    const dialog = await screen.findByRole('dialog', { name: 'Завершить все сессии' });
    expect(deleteCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Завершить все' }));
    });

    const calls = deleteCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe('/api/v1/me/sessions');
  });

  it('reports a failed load and retries on demand', async () => {
    const fetchMock = await renderPage({ sessionsStatus: 503 });

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось выполнить запрос');
    expect(banner).toHaveTextContent('HTTP 503');

    // Второй заход отвечает нормально — полоса ошибки должна уйти.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return Promise.resolve(new Response(JSON.stringify(ME)));
      if (url === '/api/v1/me/sessions')
        return Promise.resolve(new Response(JSON.stringify(SESSIONS)));
      if (url === '/api/v1/me/names') return Promise.resolve(new Response(JSON.stringify(NAMES)));
      return Promise.resolve(new Response('{}'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
  });

  it('показывает свою игровую статистику и последние матчи', async () => {
    await renderPage();

    const dossier = await screen.findByTestId('dossier');
    expect(dossier).toHaveAttribute('data-player-id', 'player-1');
    expect(dossier).toHaveAttribute('data-title', 'Игровая статистика');
    // Своя статистика считается по всем серверам сразу — выбирать нечего.
    expect(dossier).toHaveAttribute('data-server-filter', 'false');
    expect(screen.getByTestId('recent-matches')).toHaveAttribute('data-player-id', 'player-1');
  });

  it('ставит статистику выше профиля и не зажимает страницу в узкую колонку', async () => {
    installFetch();
    let container!: HTMLElement;
    await act(async () => {
      container = render(<AccountPage />).container;
    });

    const shell = container.firstElementChild;
    expect(shell).toHaveClass('max-w-[1600px]');
    expect(shell?.className).not.toContain('max-w-3xl');
    expect(shell?.className).not.toContain('mx-auto');

    const dossier = await screen.findByTestId('dossier');
    const profile = screen.getByText('Профиль');
    // SteamID64 и число ключей — справка, а не то, ради чего сюда заходят.
    expect(dossier.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('не рисует статистику, пока профиль не загружен', async () => {
    await renderPage({ meStatus: 503 });

    expect(screen.queryByTestId('dossier')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recent-matches')).not.toBeInTheDocument();
  });

  it('polls the profile, the names and the session list on the interval', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = installFetch();
      render(<AccountPage />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    } finally {
      vi.useRealTimers();
    }
  });
});
