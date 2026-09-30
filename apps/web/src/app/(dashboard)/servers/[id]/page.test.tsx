// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/AdminsCfgDriftBanner', () => ({ AdminsCfgDriftBanner: () => null }));
vi.mock('@/components/BroadcastComposer', () => ({ BroadcastComposer: () => null }));
const logConsoleProps: { current: { lines: unknown[]; live?: boolean } | null } = {
  current: null,
};
vi.mock('@/components/LogConsole', () => ({
  LogConsole: (props: { lines: unknown[]; live?: boolean }) => {
    logConsoleProps.current = props;
    return null;
  },
}));
vi.mock('@/components/ServerLogFiles', () => ({ ServerLogFiles: () => null }));
vi.mock('./ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('./live-players', () => ({
  LivePlayers: () => <section aria-label="Игроки онлайн" />,
}));
vi.mock('./map-widget', () => ({ MapWidget: () => null }));
vi.mock('./SeedCallButton', () => ({ SeedCallButton: () => null }));
const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));
vi.mock('@/lib/ws-backoff', () => ({ nextBackoffMs: vi.fn(() => 1000) }));

import ServerDetailPage from './page';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function serverResponseFixture(status: string, extra: Record<string, unknown> = {}) {
  return {
    server: {
      id: SERVER_ID,
      display_name: 'Test Server',
      slug: 'test-server',
      status,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    settings: null,
    rcon_status: { state: 'not_polled' },
    container: null,
    host: null,
    ...extra,
  };
}

/** Отдаёт сервер (по умолчанию остановленный) и пустые права; всё остальное — ошибка теста. */
function stubServerFetch(
  status = 'stopped',
  extra: Record<string, unknown> = {},
  permissions: string[] = [],
) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/v1/me') {
      return {
        ok: true,
        json: async () => ({ squad_permissions: [], permissions }),
      } as Response;
    }
    if (url === `/api/v1/servers/${SERVER_ID}`) {
      return { ok: true, json: async () => serverResponseFixture(status, extra) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.unstubAllGlobals();
});

describe('ServerDetailPage', () => {
  it('is a valid React component', () => {
    expect(ServerDetailPage).toBeDefined();
    expect(typeof ServerDetailPage).toBe('function');
  });

  it('leaves the only <h1> to the section layout', async () => {
    stubServerFetch();

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    await screen.findByRole('region', { name: 'Игроки онлайн' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('puts the live roster below the alert banners', async () => {
    // Баннер аварии обязан остаться выше списка на сто строк.
    stubServerFetch('running', { crash_loop: true });

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    const roster = await screen.findByRole('region', { name: 'Игроки онлайн' });
    const crashBanner = screen.getByText('Сервер в цикле аварий — автоперезапуск отключён');

    expect(
      crashBanner.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('не показывает карточку «Состояние»: ни статусов, ни кнопок жизненного цикла', async () => {
    // Сидинг, «виден в Steam», аптайм и прочие статусы с обзора убраны, а
    // старт/стоп/удаление переехали в «Настройки».
    stubServerFetch('stopped', {
      crash_loop: false,
      seeding: {
        state: 'seeding',
        current_players: 9,
        live_at: 60,
        progress_pct: 15,
        started_at: null,
      },
      a2s_status: { visible: false },
    });

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    await screen.findByRole('region', { name: 'Игроки онлайн' });
    expect(screen.queryByRole('heading', { name: 'Состояние' })).not.toBeInTheDocument();
    expect(screen.queryByText(/до live/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Steam/)).not.toBeInTheDocument();
    expect(screen.queryByText(/обновлено/)).not.toBeInTheDocument();
    for (const name of ['Старт', 'Стоп', 'Рестарт', 'Обновить игру', /Опасная зона/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('не показывает ряд плиток со сводкой (игроки, тикрейт, CPU/RAM)', async () => {
    // Те же числа читаются в ростере — дублирующий ряд убран.
    stubServerFetch('running');

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    await screen.findByRole('region', { name: 'Игроки онлайн' });
    expect(screen.queryByText('Тикрейт')).not.toBeInTheDocument();
    expect(screen.queryByText('CPU')).not.toBeInTheDocument();
    expect(screen.queryByText('RAM')).not.toBeInTheDocument();
  });

  it('offers a retry when the server cannot be loaded, and recovers on it', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/me') {
          return {
            ok: true,
            json: async () => ({ squad_permissions: [], permissions: [] }),
          } as Response;
        }
        if (url === `/api/v1/servers/${SERVER_ID}`) {
          if (failing) return { ok: false, status: 503, json: async () => ({}) } as Response;
          return { ok: true, json: async () => serverResponseFixture('stopped') } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('Не удалось загрузить сервер')).toBeInTheDocument();

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    });

    expect(await screen.findByRole('region', { name: 'Игроки онлайн' })).toBeInTheDocument();
  });
});

describe('ServerDetailPage — внешний сервер', () => {
  function externalFixture() {
    return {
      ...serverResponseFixture('running'),
      server: { ...serverResponseFixture('running').server, runtime: 'external' },
      settings: {
        server_id: SERVER_ID,
        game_port: 7787,
        query_port: 27165,
        beacon_port: 15000,
        rcon_port: 21114,
        max_players: 100,
        tickrate: 50,
        multihome: '0.0.0.0',
        install_path: '',
      },
      host: { address: '203.0.113.10', hostname: '203.0.113.10' },
      connection: { rcon_host: '203.0.113.10', rcon_port: 21114 },
    };
  }

  it('прячет управление контейнером и лог, показывает адрес RCON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/servers/${SERVER_ID}`) {
          return { ok: true, json: async () => externalFixture() } as Response;
        }
        if (url === '/api/v1/me') {
          return {
            ok: true,
            json: async () => ({ squad_permissions: [], permissions: [] }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    // Никакого WebSocket к docker logs у внешнего сервера быть не должно.
    const wsCtor = vi.fn();
    vi.stubGlobal('WebSocket', wsCtor);

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Старт' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Стоп' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Рестарт' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Обновить игру' })).not.toBeInTheDocument();
    expect(screen.queryByText('CPU')).not.toBeInTheDocument();
    expect(screen.queryByText('Порт маяка')).not.toBeInTheDocument();
    expect(wsCtor).not.toHaveBeenCalled();
  });
});

describe('ServerDetailPage — живой статус RCON', () => {
  function serverFetches(fetchMock: ReturnType<typeof stubServerFetch>): number {
    return fetchMock.mock.calls.filter(([url]) => url === `/api/v1/servers/${SERVER_ID}`).length;
  }

  it('перечитывает карточку сразу по rcon.status этого сервера, не дожидаясь опроса', async () => {
    const fetchMock = stubServerFetch('running');
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });
    await screen.findByRole('region', { name: 'Игроки онлайн' });
    const before = serverFetches(fetchMock);

    await act(async () => {
      liveHandlers.get('rcon.status')?.({
        type: 'rcon.status',
        ts: '2026-09-25T10:00:00.000Z',
        data: { server_id: 'another-server', state: 'connected', player_count: 3 },
      });
    });
    expect(serverFetches(fetchMock)).toBe(before);

    await act(async () => {
      liveHandlers.get('rcon.status')?.({
        type: 'rcon.status',
        ts: '2026-09-25T10:00:00.000Z',
        data: { server_id: SERVER_ID, state: 'connected', player_count: 3 },
      });
    });
    expect(serverFetches(fetchMock)).toBe(before + 1);
  });
});

describe('ServerDetailPage — живой лог контейнера (#1239)', () => {
  function stubWithPermissions(permissions: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/me') {
          return {
            ok: true,
            json: async () => ({ squad_permissions: [], permissions }),
          } as Response;
        }
        if (url === `/api/v1/servers/${SERVER_ID}`) {
          return { ok: true, json: async () => serverResponseFixture('running') } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const wsCtor = vi.fn(function FakeWebSocket(this: Record<string, unknown>) {
      this.readyState = 0;
      this.close = vi.fn();
    });
    vi.stubGlobal('WebSocket', wsCtor);
    return wsCtor;
  }

  async function renderPage() {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });
    await act(async () => {});
  }

  it('не открывает поток лога без права server:download_logs', async () => {
    const wsCtor = stubWithPermissions([]);
    await renderPage();
    expect(wsCtor).not.toHaveBeenCalled();
  });

  it('открывает поток лога с правом server:download_logs', async () => {
    const wsCtor = stubWithPermissions(['server:download_logs']);
    await renderPage();
    expect(wsCtor).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/servers/${SERVER_ID}/logs/ws`),
    );
  });
});

class FakeLogSocket {
  static instances: FakeLogSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeLogSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeLogSocket.instances.push(this);
  }
  close() {
    this.readyState = FakeLogSocket.CLOSED;
  }
  simulateOpen() {
    this.readyState = FakeLogSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('ServerDetailPage — поток журнала контейнера', () => {
  beforeEach(() => {
    FakeLogSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeLogSocket);
  });

  it('очищает буфер строк при каждом (пере)подключении вместо повтора бэкфилла (#631)', async () => {
    stubServerFetch('running', {}, ['server:download_logs']);
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });
    await screen.findByRole('region', { name: 'Игроки онлайн' });

    const first = FakeLogSocket.instances[0];
    if (!first) throw new Error('no WebSocket instance opened');
    await act(async () => {
      first.simulateOpen();
      first.simulateMessage({ ts: '2026-01-01T00:00:00Z', message: 'line-1' });
      first.simulateMessage({ ts: '2026-01-01T00:00:01Z', message: 'line-2' });
    });
    expect(logConsoleProps.current?.lines).toHaveLength(2);

    // A reconnect always re-backfills the last 200 lines server-side; the
    // client buffer must reset to empty rather than append on top of what
    // is already there, or every reconnect would duplicate up to 200 lines.
    vi.useFakeTimers();
    try {
      await act(async () => {
        first.onclose?.({ code: 1006, wasClean: false });
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      vi.useRealTimers();
    }
    const second = FakeLogSocket.instances[1];
    if (!second) throw new Error('no reconnect WebSocket opened');
    await act(async () => {
      second.simulateOpen();
    });
    expect(logConsoleProps.current?.lines).toHaveLength(0);

    await act(async () => {
      second.simulateMessage({ ts: '2026-01-01T00:00:02Z', message: 'line-1-again' });
    });
    expect(logConsoleProps.current?.lines).toHaveLength(1);
  });

  it('игнорирует события устаревшего сокета вместо дублирования строк и лишнего переподключения (#632)', async () => {
    stubServerFetch('running', {}, ['server:download_logs']);
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });
    await screen.findByRole('region', { name: 'Игроки онлайн' });

    const stale = FakeLogSocket.instances[0];
    if (!stale) throw new Error('no WebSocket instance opened');
    await act(async () => {
      stale.simulateOpen();
    });
    // A stale-but-not-yet-closed socket (CLOSING) must not block a forced
    // reconnect from replacing it — the visibilitychange/online handlers
    // rely on that to recover a socket the browser is silently dropping.
    stale.readyState = FakeLogSocket.CLOSING;
    const staleOnClose = stale.onclose;
    const staleOnMessage = stale.onmessage;

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    const fresh = FakeLogSocket.instances[1];
    if (!fresh) throw new Error('forced reconnect did not open a new socket');
    await act(async () => {
      fresh.simulateOpen();
    });
    expect(logConsoleProps.current?.live).toBe(true);

    // The stale socket's own handlers, captured before the switch, must be
    // no-ops now that `wsRef.current` points at `fresh` — otherwise its
    // eventual onclose would flip `live` back off and schedule a second,
    // redundant reconnect, and its onmessage would keep appending duplicate
    // lines from a connection the operator can no longer see.
    await act(async () => {
      staleOnMessage?.({ data: JSON.stringify({ message: 'from stale socket' }) });
      staleOnClose?.({ code: 1000, wasClean: true });
    });
    expect(logConsoleProps.current?.live).toBe(true);
    expect(logConsoleProps.current?.lines).toHaveLength(0);
    expect(FakeLogSocket.instances).toHaveLength(2);
  });
});

describe('ServerDetailPage — опрос состояния сервера (#633)', () => {
  function serverFetches(fetchMock: ReturnType<typeof stubServerFetch>): number {
    return fetchMock.mock.calls.filter(([url]) => url === `/api/v1/servers/${SERVER_ID}`).length;
  }

  it('не опрашивает /servers/:id, пока вкладка скрыта', async () => {
    const fetchMock = stubServerFetch('running');
    vi.useFakeTimers();
    try {
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
          </Suspense>,
        );
      });
      const before = serverFetches(fetchMock);

      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      // Three POLL_INTERVAL_MS ticks elapsed with the tab hidden: none of
      // them should have reached the network.
      expect(serverFetches(fetchMock)).toBe(before);

      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(serverFetches(fetchMock)).toBeGreaterThan(before);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      vi.useRealTimers();
    }
  });

  it('не запускает новый опрос поверх ещё не завершившегося запроса', async () => {
    let resolveSecond: (() => void) | null = () => undefined;
    let calls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/me') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ squad_permissions: [], permissions: [] }),
        } as Response);
      }
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => serverResponseFixture('running'),
        } as Response);
      }
      // The second tick's request never resolves within this test, modeling
      // a slow docker-stats call the poller must not pile another request
      // behind.
      return new Promise<Response>((resolve) => {
        resolveSecond = () =>
          resolve({ ok: true, json: async () => serverResponseFixture('running') } as Response);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    try {
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
          </Suspense>,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(calls).toBe(2);

      // A further two ticks must not start a third request while the second
      // is still in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(calls).toBe(2);

      resolveSecond?.();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
