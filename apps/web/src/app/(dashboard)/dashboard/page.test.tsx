// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '1',
    canonical_name: 'T',
    permissions: ['servers.view'],
  }),
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

let capturedOnStart: ((serverIds: string[]) => Promise<void>) | undefined;
vi.mock('@/components/DepotUpdateModal', () => ({
  DepotUpdateModal: (props: { onStart: (serverIds: string[]) => Promise<void> }) => {
    capturedOnStart = props.onStart;
    return null;
  },
}));
vi.mock('@/components/UpdateProgressModal', () => ({ UpdateProgressModal: () => null }));
vi.mock('@/components/DiskBreakdownModal', () => ({ DiskBreakdownModal: () => null }));
vi.mock('@/components/DockerPruneButton', () => ({ DockerPruneButton: () => null }));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/components/MetricHistoryModal', () => ({ MetricHistoryModal: () => null }));
vi.mock('@/components/RestartBridgeButton', () => ({ RestartBridgeButton: () => null }));
vi.mock('@/lib/format', () => ({
  formatBytes: vi.fn((v: number) => `${v}B`),
  formatBytesPerSec: vi.fn((v: number) => `${v}B/s`),
  formatPercent: vi.fn((v: number) => `${v}%`),
  formatUptime: vi.fn(() => '1d'),
  ratio: vi.fn(() => 0),
}));
vi.mock('@/lib/host-health', () => ({
  computeHostHealth: vi.fn(() => ({ level: 'healthy', reasons: [] })),
  thresholdTone: vi.fn(() => 'emerald'),
}));

import DashboardPage from './page';

/**
 * jsdom знает элемент `<dialog>`, но не реализует `showModal()`/`close()`.
 * Полифилл воспроизводит ровно то, на что опирается `Modal`: атрибут `open` и
 * событие `close`. Тот же приём, что в `src/components/ui/AlertDialog.test.tsx`.
 */
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

const SERVERS = [
  {
    id: 's1',
    display_name: 'Первый',
    slug: 'first',
    status: 'running',
    player_count: 42,
    rcon_state: 'connected',
    last_poll_at: '2026-08-22T10:00:00.000Z',
  },
  {
    id: 's2',
    display_name: 'Второй',
    slug: 'second',
    status: 'stopped',
    player_count: null,
    rcon_state: null,
    last_poll_at: null,
  },
];

const AUDIT = [
  {
    id: 'a1',
    created_at: '2026-08-22T10:00:00.000Z',
    actor_kind: 'system',
    action_type: 'server.restart',
    target_type: 'server',
    target_id: 'abcdef1234',
    status_code: 200,
  },
];

interface FetchCall {
  url: string;
  init?: RequestInit;
}

type RouteBody = { status?: number; body?: unknown };

/**
 * Отвечает на все запросы дашборда. Неизвестный адрес получает 404 — так
 * забытый в тесте маршрут виден по пустому блоку, а не по зависшему промису.
 */
function stubFetch(routes: Record<string, RouteBody>): FetchCall[] {
  const calls: FetchCall[] = [];
  const defaults: Record<string, RouteBody> = {
    '/api/v1/host/bridge-status': { body: { connected: true, version: '1.0', round_trip_ms: 3 } },
    '/api/v1/host/info': { body: null, status: 500 },
    '/api/v1/host/metrics': { body: null, status: 500 },
    '/api/v1/servers': { body: { items: SERVERS } },
    '/api/v1/audit': { body: { items: AUDIT } },
    '/ready': { body: { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } } },
    '/api/v1/health/workers': { body: { items: [] } },
    '/api/v1/host/disk-usage': { body: null, status: 500 },
    '/api/v1/analytics/': { body: null, status: 500 },
  };
  const table = { ...defaults, ...routes };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(table)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => url.startsWith(prefix));
      const route = key ? table[key] : undefined;
      const status = route?.status ?? (route ? 200 : 404);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => route?.body,
      } as Response;
    }),
  );

  return calls;
}

async function renderDashboard() {
  const view = render(<DashboardPage />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  capturedOnStart = undefined;
});

describe('DashboardPage', () => {
  it('is a valid React component', () => {
    expect(DashboardPage).toBeDefined();
    expect(typeof DashboardPage).toBe('function');
  });

  it('posts server_ids (not stop_server_ids) to /api/v1/depot/update on start', async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/ready') {
          return {
            ok: true,
            json: async () => ({ status: 'ok', checks: {} }),
          } as Response;
        }
        if (url === '/api/v1/depot/update') {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return { ok: true, json: async () => ({ status: 'started' }) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedOnStart).toBeDefined();
    await act(async () => {
      await capturedOnStart?.(['server-1', 'server-2']);
    });

    expect(capturedBody).toEqual({ server_ids: ['server-1', 'server-2'] });
  });

  it('carries exactly one first-level heading', async () => {
    stubFetch({});
    await renderDashboard();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Дашборд');
  });

  it('announces the server list as loading before the first response arrives', async () => {
    // Ответ не приходит никогда: так виден именно момент загрузки.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<DashboardPage />);

    expect(screen.getByText('Загружаем список серверов')).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Серверов нет')).not.toBeInTheDocument();
  });

  it('offers installing the first server when the list came back empty', async () => {
    stubFetch({ '/api/v1/servers': { body: { items: [] } } });
    await renderDashboard();

    expect(screen.getByText('Серверов нет')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Установить первый' })).toHaveAttribute(
      'href',
      '/servers/new',
    );
  });

  it('reports a failed server request and retries on demand', async () => {
    const calls = stubFetch({ '/api/v1/servers': { status: 503 } });
    await renderDashboard();

    // Панели аналитики в этом сценарии тоже сообщают об ошибке, поэтому
    // баннер списка серверов ищется по своему тексту, а не по одной роли.
    const banner = screen
      .getByText('Список серверов не загрузился')
      .closest<HTMLElement>('[role="alert"]');
    if (!banner) throw new Error('ошибка списка серверов показана не баннером');

    const before = calls.filter((c) => c.url === '/api/v1/servers').length;
    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Повторить' }));
    });
    expect(calls.filter((c) => c.url === '/api/v1/servers').length).toBeGreaterThan(before);
  });

  it('shows only columns that carry data, and links the row from its first cell', async () => {
    stubFetch({});
    await renderDashboard();

    const table = screen.getByRole('table', { name: 'Серверы' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[↑↓⇅]/g, '').trim());
    expect(headers).toEqual(['Имя', 'Статус', 'Игроки', 'RCON', 'Последний опрос', 'Действия']);
    // Обе колонки печатали константу и были удалены вместе с ней.
    expect(within(table).queryByText('Карта / слой')).not.toBeInTheDocument();
    expect(within(table).queryByText('CPU / RAM')).not.toBeInTheDocument();

    expect(within(table).getByRole('link', { name: /Первый/ })).toHaveAttribute(
      'href',
      '/servers/s1',
    );
  });

  it('sorts by players and announces the direction with aria-sort', async () => {
    stubFetch({});
    await renderDashboard();

    const table = screen.getByRole('table', { name: 'Серверы' });
    const playersHeader = within(table).getAllByRole('columnheader')[2];
    expect(playersHeader).toHaveAttribute('aria-sort', 'none');

    await act(async () => {
      fireEvent.click(within(playersHeader).getByRole('button'));
    });

    expect(playersHeader).toHaveAttribute('aria-sort', 'ascending');
    const firstBodyRow = within(table).getAllByRole('row')[1];
    expect(firstBodyRow).toHaveTextContent('Второй');
  });

  it('confirms a restart in a dialog instead of window.confirm', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    const calls = stubFetch({ '/api/v1/servers/s1/restart': { body: { ok: true } } });
    const { container } = await renderDashboard();

    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('строка сервера не отрисовала диалог подтверждения');
    expect(dialog).not.toHaveAttribute('open');

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Перезапуск' })[0]);
    });

    expect(dialog).toHaveAttribute('open');
    expect(calls.some((c) => c.url === '/api/v1/servers/s1/restart')).toBe(false);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Перезапустить' }));
    });

    const restart = calls.find((c) => c.url === '/api/v1/servers/s1/restart');
    expect(restart?.init?.method).toBe('POST');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancelling the restart dialog sends nothing', async () => {
    const calls = stubFetch({});
    const { container } = await renderDashboard();

    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('строка сервера не отрисовала диалог подтверждения');

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Перезапуск' })[0]);
    });
    // Крестик окна тоже называется «Отмена», поэтому берётся кнопка подвала.
    const cancel = within(dialog).getAllByRole('button', { name: 'Отмена' }).at(-1);
    if (!cancel) throw new Error('в подвале диалога нет кнопки отмены');
    await act(async () => {
      fireEvent.click(cancel);
    });

    expect(dialog).not.toHaveAttribute('open');
    expect(calls.some((c) => c.url.includes('/restart'))).toBe(false);
  });

  it('a stopped server cannot be restarted', async () => {
    stubFetch({});
    await renderDashboard();

    const buttons = screen.getAllByRole('button', { name: 'Перезапуск' });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
  });

  it('separates an empty activity feed from one emptied by the filter', async () => {
    stubFetch({});
    await renderDashboard();

    expect(screen.getByText('server.restart')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Ошибки' }));
    });

    const empty = screen.getByText('Под фильтр ничего не подходит');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'filtered');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтр' }));
    });
    expect(screen.getByText('server.restart')).toBeInTheDocument();
  });

  it('shows the initial empty state when the audit feed itself is empty', async () => {
    stubFetch({ '/api/v1/audit': { body: { items: [] } } });
    await renderDashboard();

    const empty = screen.getByText('Действий пока нет');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
  });
});
