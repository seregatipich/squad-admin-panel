// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/A2SIndicator', () => ({ A2SIndicator: () => null }));
vi.mock('@/components/AdminsCfgDriftBanner', () => ({ AdminsCfgDriftBanner: () => null }));
vi.mock('@/components/BroadcastComposer', () => ({ BroadcastComposer: () => null }));
vi.mock('@/components/CrashBadge', () => ({ CrashBadge: () => null }));
vi.mock('@/components/ForceStopDialog', () => ({ ForceStopDialog: () => null }));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));
vi.mock('@/components/ServerLogFiles', () => ({ ServerLogFiles: () => null }));
vi.mock('./ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('./live-players', () => ({
  LivePlayers: () => <section aria-label="Игроки онлайн" />,
}));
vi.mock('./map-widget', () => ({ MapWidget: () => null }));
vi.mock('./SeedCallButton', () => ({ SeedCallButton: () => null }));
vi.mock('./SeedingBadge', () => ({ SeedingBadge: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));
vi.mock('@/lib/ws-backoff', () => ({ nextBackoffMs: vi.fn(() => 1000) }));

let latestProgressModalProps:
  | { open: boolean; onDone?: (final: 'done' | 'error', error?: string) => void }
  | undefined;
vi.mock('@/components/UpdateProgressModal', () => ({
  UpdateProgressModal: (props: {
    open: boolean;
    onDone?: (final: 'done' | 'error', error?: string) => void;
  }) => {
    latestProgressModalProps = props;
    return null;
  },
}));

import ServerDetailPage from './page';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

/**
 * jsdom знает `<dialog>`, но не реализует `showModal()`/`close()`. Диалог
 * подтверждения удаления построен на нативном элементе, поэтому тест
 * воспроизводит ровно то, на что этот примитив опирается.
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
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/me') {
      return {
        ok: true,
        json: async () => ({ squad_permissions: [], permissions: [] }),
      } as Response;
    }
    if (url === `/api/v1/servers/${SERVER_ID}`) {
      if (init?.method === 'DELETE') return { ok: true, text: async () => '' } as Response;
      return { ok: true, json: async () => serverResponseFixture(status, extra) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deleteCalls(fetchMock: ReturnType<typeof stubServerFetch>): number {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === 'DELETE').length;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  latestProgressModalProps = undefined;
});

describe('ServerDetailPage', () => {
  it('is a valid React component', () => {
    expect(ServerDetailPage).toBeDefined();
    expect(typeof ServerDetailPage).toBe('function');
  });

  it('starts an update, opens the progress modal, and resets on completion', async () => {
    let updateCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `/api/v1/servers/${SERVER_ID}`) {
          return { ok: true, json: async () => serverResponseFixture('stopped') } as Response;
        }
        if (url === '/api/v1/me') {
          return {
            ok: true,
            json: async () => ({ squad_permissions: [], permissions: [] }),
          } as Response;
        }
        if (url === `/api/v1/servers/${SERVER_ID}/update` && init?.method === 'POST') {
          updateCalled = true;
          return {
            ok: true,
            json: async () => ({ status: 'started', server_id: SERVER_ID }),
          } as Response;
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

    const updateButton = await screen.findByRole('button', { name: 'Обновить игру' });
    fireEvent.click(updateButton);

    await waitFor(() => expect(updateCalled).toBe(true));
    await waitFor(() => expect(latestProgressModalProps?.open).toBe(true));

    expect(await screen.findByText('Обновление... (открыть лог)')).toBeInTheDocument();

    act(() => latestProgressModalProps?.onDone?.('done'));

    await waitFor(() =>
      expect(screen.queryByText('Обновление... (открыть лог)')).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: 'Обновить игру' })).toBeInTheDocument();
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

    await screen.findByRole('heading', { name: 'Состояние' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('puts the live roster above the state card, below the alert banners', async () => {
    // Ростер читают постоянно, состояние и порты — один раз при настройке;
    // баннер аварии при этом обязан остаться выше списка на сто строк.
    stubServerFetch('running', { crash_loop: true });

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    const roster = await screen.findByRole('region', { name: 'Игроки онлайн' });
    const state = screen.getByRole('heading', { name: 'Состояние' });
    const crashBanner = screen.getByText('Сервер в цикле аварий — автоперезапуск отключён');

    expect(roster.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      crashBanner.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('не показывает ряд плиток со сводкой (игроки, тикрейт, CPU/RAM)', async () => {
    // Те же числа читаются в ростере и в карточке состояния — дублирующий ряд убран.
    stubServerFetch('running');

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    await screen.findByRole('heading', { name: 'Состояние' });
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

    expect(await screen.findByRole('heading', { name: 'Состояние' })).toBeInTheDocument();
  });

  it('deletes the server only after its exact name is typed back', async () => {
    const fetchMock = stubServerFetch();

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: /Опасная зона/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Удалить сервер/ }));

    const confirm = await screen.findByRole('button', { name: 'Удалить сервер' });
    expect(confirm).toBeDisabled();
    expect(deleteCalls(fetchMock)).toBe(0);

    fireEvent.change(screen.getByLabelText('Введите имя сервера'), {
      target: { value: 'Test Server' },
    });
    expect(confirm).toBeEnabled();

    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(deleteCalls(fetchMock)).toBe(1));
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

    expect(await screen.findByText(/Внешний сервер: запуск и остановка/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Старт' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Стоп' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Рестарт' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Обновить игру' })).not.toBeInTheDocument();
    expect(screen.queryByText('CPU')).not.toBeInTheDocument();
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.queryByText('Порт маяка')).not.toBeInTheDocument();
    expect(wsCtor).not.toHaveBeenCalled();
  });
});
