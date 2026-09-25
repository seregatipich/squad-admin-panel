// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/AdminsCfgDriftBanner', () => ({ AdminsCfgDriftBanner: () => null }));
vi.mock('@/components/BroadcastComposer', () => ({ BroadcastComposer: () => null }));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));
vi.mock('@/components/ServerLogFiles', () => ({ ServerLogFiles: () => null }));
vi.mock('./ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('./live-players', () => ({
  LivePlayers: () => <section aria-label="Игроки онлайн" />,
}));
vi.mock('./map-widget', () => ({ MapWidget: () => null }));
vi.mock('./SeedCallButton', () => ({ SeedCallButton: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));
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
function stubServerFetch(status = 'stopped', extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/v1/me') {
      return {
        ok: true,
        json: async () => ({ squad_permissions: [], permissions: [] }),
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
