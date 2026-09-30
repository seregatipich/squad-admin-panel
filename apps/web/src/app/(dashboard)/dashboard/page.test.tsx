// @vitest-environment happy-dom
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
    '/api/v1/health/dependencies': {
      body: { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } },
    },
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
        if (url === '/api/v1/health/dependencies') {
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

  // #774: the modal shows the rejection message, so it must name the API's reason.
  it('rejects onStart with the API error code when the update is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/health/dependencies') {
          return { ok: true, json: async () => ({ status: 'ok', checks: {} }) } as Response;
        }
        if (url === '/api/v1/depot/update') {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: 'update_in_progress' }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
    });

    await expect(capturedOnStart?.(['server-1'])).rejects.toThrow('update_in_progress');
  });

  it('maps servers_running from depot/update to a Russian hint with the missing count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/health/dependencies') {
          return { ok: true, json: async () => ({ status: 'ok', checks: {} }) } as Response;
        }
        if (url === '/api/v1/depot/update') {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: 'servers_running', server_ids: ['a', 'b'] }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
    });

    await expect(capturedOnStart?.(['s1'])).rejects.toThrow(
      'Отметьте все запущенные серверы для остановки: не выбрано 2.',
    );
  });

  it('falls back to the HTTP status for other depot/update failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/health/dependencies') {
          return { ok: true, json: async () => ({ status: 'ok', checks: {} }) } as Response;
        }
        if (url === '/api/v1/depot/update') {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
    });

    await expect(capturedOnStart?.(['s1'])).rejects.toThrow('HTTP 500');
  });

  it('does not flag a worker crit before its heartbeat TTL, only before 2x the interval (#548)', async () => {
    // 20s: behind the 2×HEARTBEAT_INTERVAL_MS=10s "warn" threshold, but well
    // under the HEARTBEAT_TTL_SECONDS=30s the worker is actually considered
    // dead by — the old hardcoded 15s crit threshold fired here regardless.
    stubFetch({
      '/api/v1/health/workers': {
        body: { items: [{ name: 'rcon', age_ms: 20_000, pid: 1, status: 'жив' }] },
      },
    });
    await renderDashboard();

    const row = await screen.findByText('worker-rcon');
    const dot = row.closest('li')?.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain('bg-warn');
    expect(dot?.className).not.toContain('bg-crit');
  });

  it('reads PostgreSQL and Redis state from the authenticated API, not the public /ready path', async () => {
    const calls = stubFetch({});
    await renderDashboard();
    const urls = calls.map((call) => call.url);
    expect(urls).toContain('/api/v1/health/dependencies');
    expect(urls).not.toContain('/ready');
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
    const playersHeader = within(table).getAllByRole('columnheader')[2]!;
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
      fireEvent.click(screen.getAllByRole('button', { name: 'Перезапуск' })[0]!);
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
      fireEvent.click(screen.getAllByRole('button', { name: 'Перезапуск' })[0]!);
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

  /*
   * Цель записи раньше всегда резалась до восьми символов: UUID это шло на
   * пользу, а `host · localhost` превращалось в бессмысленное `host · localhos`.
   */
  it('shortens only UUID targets in the activity feed', async () => {
    stubFetch({
      '/api/v1/audit': {
        body: {
          items: [
            {
              id: 'a-host',
              created_at: '2026-08-22T10:00:00.000Z',
              actor_kind: 'system',
              action_type: 'host.docker_prune',
              target_type: 'host',
              target_id: 'localhost',
              status_code: 502,
            },
            {
              id: 'a-uuid',
              created_at: '2026-08-22T09:00:00.000Z',
              actor_kind: 'system',
              action_type: 'server.restart',
              target_type: 'server',
              target_id: 'c674f105-0824-42df-ac5e-8d043125766f',
              status_code: 200,
            },
            {
              id: 'a-days',
              created_at: '2026-08-22T08:00:00.000Z',
              actor_kind: 'steam',
              action_type: 'settings.chat_flags.retention',
              target_type: 'chat_flags',
              target_id: 'days:30',
              status_code: 200,
            },
          ],
        },
      },
    });
    await renderDashboard();

    expect(screen.getByText('host · localhost')).toBeInTheDocument();
    expect(screen.getByText('server · c674f105')).toBeInTheDocument();
    expect(screen.getByText('chat_flags · days:30')).toBeInTheDocument();
    expect(screen.queryByText('host · localhos')).not.toBeInTheDocument();
  });

  /*
   * Карточка серверов раньше стояла на `h-full` и вытягивалась под соседнюю
   * карточку хоста: три строки таблицы и триста пикселей пустоты под ними.
   */
  it('does not stretch the servers card to the height of its neighbour', async () => {
    stubFetch({});
    await renderDashboard();

    const card = screen.getByRole('heading', { name: /^Серверы/ }).closest('section');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('h-full')).toBe(false);
  });

  /*
   * Регрессия: карточка хоста крутила четыре скелетона «загружаем метрики»
   * бесконечно, когда агент лежал, — данные не придут никогда, а панель
   * обещала их вот-вот показать.
   */
  it('tells a downed bridge apart from metrics that are still loading', async () => {
    stubFetch({ '/api/v1/host/bridge-status': { body: { connected: false } } });
    await renderDashboard();

    expect(screen.getByText('Метрики хоста недоступны')).toBeInTheDocument();
    expect(screen.queryByText('Загружаем метрики хоста')).not.toBeInTheDocument();
    expect(screen.getByText('Имя, ОС и аптайм читает агент — он не отвечает.')).toBeInTheDocument();
    expect(screen.queryByText('Загружаем сведения о хосте…')).not.toBeInTheDocument();
  });

  it('keeps the loading skeletons while the bridge is up but metrics have not arrived', async () => {
    // Never resolves: this is genuinely "the first response hasn't landed
    // yet", not a repeated failure (see the next test for that case).
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/host/info') || url.startsWith('/api/v1/host/metrics')) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            if (url.startsWith('/api/v1/host/bridge-status')) {
              return { connected: true, version: '1.0', round_trip_ms: 3 };
            }
            if (url.startsWith('/api/v1/servers')) return { items: SERVERS };
            if (url.startsWith('/api/v1/audit')) return { items: AUDIT };
            if (url.startsWith('/api/v1/health/dependencies')) return { status: 'ok', checks: {} };
            if (url.startsWith('/api/v1/health/workers')) return { items: [] };
            return null;
          },
        } as Response);
      }),
    );
    await renderDashboard();

    expect(screen.getByText('Загружаем метрики хоста')).toBeInTheDocument();
    expect(screen.queryByText('Метрики хоста недоступны')).not.toBeInTheDocument();
    expect(screen.getByText('Загружаем сведения о хосте…')).toBeInTheDocument();
  });

  /*
   * DASH-545: до фикса ошибки info/metrics/audit/ready/workers молча
   * проглатывались, и панель хоста вечно крутила «Загружаем метрики хоста»,
   * даже когда каждый опрос отвечал одной и той же ошибкой.
   */
  it('shows an error instead of spinning forever when host metrics repeatedly fail', async () => {
    stubFetch({
      '/api/v1/host/info': { status: 500 },
      '/api/v1/host/metrics': { status: 500 },
    });
    await renderDashboard();

    expect(screen.getByText('Не удалось загрузить метрики хоста')).toBeInTheDocument();
    expect(screen.queryByText('Загружаем метрики хоста')).not.toBeInTheDocument();
    expect(screen.getByText(/Не удалось загрузить сведения о хосте/)).toBeInTheDocument();
  });

  it('names the missing permission instead of spinning forever on a 403', async () => {
    stubFetch({
      '/api/v1/host/metrics': { status: 403 },
      '/api/v1/audit': { status: 403 },
    });
    await renderDashboard();

    expect(screen.getByText('Нет прав на просмотр метрик хоста')).toBeInTheDocument();
    expect(screen.getByText('Нет прав на просмотр журнала')).toBeInTheDocument();
    expect(screen.queryByText('Действий пока нет')).not.toBeInTheDocument();
  });

  it('shows the initial empty state when the audit feed itself is empty', async () => {
    stubFetch({ '/api/v1/audit': { body: { items: [] } } });
    await renderDashboard();

    const empty = screen.getByText('Действий пока нет');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
  });

  describe('polling (DASH-546 / DASH-1334 / DASH-544)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fetches host/info once, not on every 4s poll tick', async () => {
      const calls = stubFetch({});
      vi.useFakeTimers();
      render(<DashboardPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const infoCallsAfterMount = calls.filter((c) => c.url.startsWith('/api/v1/host/info')).length;
      expect(infoCallsAfterMount).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000 * 4);
      });

      // Several poll ticks passed; host/info must still have been fetched
      // exactly once, since it forks `docker --version` on the bridge and its
      // data barely changes.
      expect(calls.filter((c) => c.url.startsWith('/api/v1/host/info')).length).toBe(1);
      expect(calls.filter((c) => c.url.startsWith('/api/v1/servers')).length).toBeGreaterThan(1);
    });

    it('does not poll while the tab is hidden', async () => {
      const calls = stubFetch({});
      vi.useFakeTimers();
      render(<DashboardPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const before = calls.filter((c) => c.url.startsWith('/api/v1/servers')).length;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000 * 5);
      });
      expect(calls.filter((c) => c.url.startsWith('/api/v1/servers')).length).toBe(before);

      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls.filter((c) => c.url.startsWith('/api/v1/servers')).length).toBeGreaterThan(
        before,
      );
    });

    it('skips a tick instead of overlapping when the previous poll is still in flight', async () => {
      let resolveServers: (() => void) | undefined;
      const calls: FetchCall[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          calls.push({ url, init });
          if (url.startsWith('/api/v1/servers')) {
            return new Promise<Response>((resolve) => {
              resolveServers = () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({ items: SERVERS }),
                } as Response);
            });
          }
          if (url.startsWith('/api/v1/host/info')) {
            return Promise.resolve({ ok: false, status: 500, json: async () => null } as Response);
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => {
              if (url.startsWith('/api/v1/host/bridge-status')) {
                return { connected: true };
              }
              if (url.startsWith('/api/v1/audit')) return { items: [] };
              if (url.startsWith('/api/v1/health/dependencies'))
                return { status: 'ok', checks: {} };
              if (url.startsWith('/api/v1/health/workers')) return { items: [] };
              return null;
            },
          } as Response);
        }),
      );
      vi.useFakeTimers();
      render(<DashboardPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const before = calls.filter((c) => c.url.startsWith('/api/v1/servers')).length;
      expect(before).toBe(1);

      // Two more ticks pass while the first /api/v1/servers request is still
      // unresolved: a second in-flight load() must not be started.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000 * 2);
      });
      expect(calls.filter((c) => c.url.startsWith('/api/v1/servers')).length).toBe(1);

      await act(async () => {
        resolveServers?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      // Now that the in-flight load finished, the next tick is free to poll again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(calls.filter((c) => c.url.startsWith('/api/v1/servers')).length).toBeGreaterThan(1);
    });
  });

  it('shows every worker with a heartbeat, not only the hardcoded four', async () => {
    stubFetch({
      '/api/v1/health/workers': {
        body: {
          items: [
            { name: 'rcon', age_ms: 1000, pid: 1, status: 'ok' },
            { name: 'scheduler', age_ms: 1000, pid: 2, status: 'ok' },
          ],
        },
      },
    });
    await renderDashboard();

    expect(screen.getByText('worker-rcon')).toBeInTheDocument();
    expect(screen.getByText('worker-scheduler')).toBeInTheDocument();
    // The other three hardcoded names still show up as missing heartbeats.
    expect(screen.getByText('worker-log-ingest')).toBeInTheDocument();
  });
});
