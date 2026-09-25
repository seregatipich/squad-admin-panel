// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push, refresh: vi.fn() })),
}));
vi.mock('@/components/ForceStopDialog', () => ({ ForceStopDialog: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

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

import { ServerControls } from './ServerControls';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function serverBody(status: string, runtime?: string) {
  return { server: { id: SERVER_ID, display_name: 'Test Server', status, runtime } };
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(status: string, runtime?: string, extra?: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === `/api/v1/servers/${SERVER_ID}` && !init?.method) {
      return { ok: true, json: async () => serverBody(status, runtime) } as Response;
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof stubFetch>, method: string, url: string): number {
  return fetchMock.mock.calls.filter((call) => call[0] === url && call[1]?.method === method)
    .length;
}

async function renderControls() {
  await act(async () => {
    render(<ServerControls serverId={SERVER_ID} />);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
  latestProgressModalProps = undefined;
});

describe('ServerControls', () => {
  it('enables start only for a stopped server and posts the start action', async () => {
    const fetchMock = stubFetch('stopped', undefined, (url, init) =>
      url === `/api/v1/servers/${SERVER_ID}/start` && init?.method === 'POST'
        ? ({ ok: true, text: async () => '' } as Response)
        : undefined,
    );
    await renderControls();

    const start = await screen.findByRole('button', { name: 'Старт' });
    expect(start).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Стоп' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Рестарт' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(start);
    });
    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST', `/api/v1/servers/${SERVER_ID}/start`)).toBe(1),
    );
  });

  it('enables stop and restart for a running server', async () => {
    stubFetch('running');
    await renderControls();

    expect(await screen.findByRole('button', { name: 'Старт' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Стоп' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Рестарт' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Обновить игру' })).not.toBeInTheDocument();
  });

  it('shows the API error when an action fails', async () => {
    stubFetch('stopped', undefined, (url, init) =>
      url === `/api/v1/servers/${SERVER_ID}/start` && init?.method === 'POST'
        ? ({ ok: false, status: 500, text: async () => 'boom' } as Response)
        : undefined,
    );
    await renderControls();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Старт' }));
    });
    expect(await screen.findByText('start failed: HTTP 500 boom')).toBeInTheDocument();
  });

  it('starts an update, opens the progress modal, and resets on completion', async () => {
    let updateCalled = false;
    stubFetch('stopped', undefined, (url, init) => {
      if (url === `/api/v1/servers/${SERVER_ID}/update` && init?.method === 'POST') {
        updateCalled = true;
        return { ok: true, json: async () => ({ status: 'started' }) } as Response;
      }
      return undefined;
    });
    await renderControls();

    fireEvent.click(await screen.findByRole('button', { name: 'Обновить игру' }));

    await waitFor(() => expect(updateCalled).toBe(true));
    await waitFor(() => expect(latestProgressModalProps?.open).toBe(true));
    expect(await screen.findByText('Обновление... (открыть лог)')).toBeInTheDocument();

    act(() => latestProgressModalProps?.onDone?.('done'));

    await waitFor(() =>
      expect(screen.queryByText('Обновление... (открыть лог)')).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: 'Обновить игру' })).toBeInTheDocument();
  });

  it('deletes the server only after its exact name is typed back', async () => {
    const fetchMock = stubFetch('stopped', undefined, (url, init) =>
      url === `/api/v1/servers/${SERVER_ID}` && init?.method === 'DELETE'
        ? ({ ok: true, text: async () => '' } as Response)
        : undefined,
    );
    await renderControls();

    fireEvent.click(await screen.findByRole('button', { name: /Опасная зона/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Удалить сервер/ }));

    const confirm = await screen.findByRole('button', { name: 'Удалить сервер' });
    expect(confirm).toBeDisabled();
    expect(callsTo(fetchMock, 'DELETE', `/api/v1/servers/${SERVER_ID}`)).toBe(0);

    fireEvent.change(screen.getByLabelText('Введите имя сервера'), {
      target: { value: 'Test Server' },
    });
    expect(confirm).toBeEnabled();

    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(callsTo(fetchMock, 'DELETE', `/api/v1/servers/${SERVER_ID}`)).toBe(1),
    );
    expect(push).toHaveBeenCalledWith(`/servers/archive/${SERVER_ID}`);
  });

  it('hides container lifecycle for an external server but keeps deletion', async () => {
    stubFetch('running', 'external');
    await renderControls();

    expect(await screen.findByText(/Внешний сервер: запуск и остановка/)).toBeInTheDocument();
    for (const name of ['Старт', 'Стоп', 'Рестарт', 'Обновить игру']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Опасная зона/ })).toBeInTheDocument();
  });

  it('renders nothing until the server has loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 }) as Response),
    );
    await renderControls();

    expect(screen.queryByRole('button', { name: /Опасная зона/ })).not.toBeInTheDocument();
  });
});
