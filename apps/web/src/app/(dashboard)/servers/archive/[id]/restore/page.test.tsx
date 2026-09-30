// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: routerPush, refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive/abc/restore'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import RestorePage from './page';

/** Minimal synchronous WebSocket stand-in for the install-progress socket. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  send() {}
}

function mockArchiveFetch(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' } }),
          { status },
        ),
      ),
    ),
  );
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense>
        <RestorePage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
  routerPush.mockClear();
});

describe('RestorePage', () => {
  it('is a valid React component', () => {
    expect(RestorePage).toBeDefined();
    expect(typeof RestorePage).toBe('function');
  });

  it('форма мастера подписана по-русски и предзаполнена из архива', async () => {
    mockArchiveFetch();
    await renderPage();

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Восстановление сервера из архива');

    expect(screen.getByLabelText(/^Идентификатор нового сервера/)).toHaveValue('eu-main-restored');
    expect(screen.getByLabelText(/^Отображаемое имя/)).toHaveValue('EU Main (restored)');
    expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' })).toHaveAttribute(
      'type',
      'submit',
    );
    expect(screen.getByRole('link', { name: 'К архиву' })).toHaveAttribute(
      'href',
      '/servers/archive',
    );
  });

  it('недоступная запись архива показывается полосой ошибки, а не формой', async () => {
    mockArchiveFetch(404);
    await renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось получить запись архива');
    expect(screen.queryByRole('button', { name: 'Создать новый сервер из бэкапа' })).toBeNull();
  });

  it('длинный slug архива обрезается до лимита схемы, а сбой сети показывается ошибкой', async () => {
    const longSlug = 'a'.repeat(60);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.reject(new Error('network down'));
        return Promise.resolve(
          new Response(
            JSON.stringify({ server: { id: 'abc', display_name: 'EU Main', slug: longSlug } }),
            { status: 200 },
          ),
        );
      }),
    );
    await renderPage();

    const slugInput = await screen.findByLabelText(/^Идентификатор нового сервера/);
    expect((slugInput as HTMLInputElement).value).toHaveLength(64);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    });
    expect(await screen.findByText(/Сбой сети или ответа API: network down/)).toBeInTheDocument();
  });
});

// #662: the 409 handler previously always said "slug taken" regardless of
// which of the three distinct 409 causes the API actually returned.
describe('#662 409 restore errors are distinguished by response body', () => {
  async function submitRestoreExpecting(errorCode: string, expectedText: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/archive/abc' && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' },
              }),
              { status: 200 },
            ),
          );
        }
        if (url === '/api/v1/servers/archive/abc/restore' && init?.method === 'POST') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: errorCode }), { status: 409 }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
      }),
    );
    await renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await user.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(expectedText);
  }

  it('slug_in_use: "идентификатор уже занят"', async () => {
    await submitRestoreExpecting('slug_in_use', 'Этот идентификатор уже занят активным сервером');
  });

  it('external_server: explains the archive is external and must be re-attached', async () => {
    await submitRestoreExpecting('external_server', 'внешний сервер');
  });

  it('archive_settings_missing: explains settings are missing from the archive', async () => {
    await submitRestoreExpecting('archive_settings_missing', 'нет настроек сервера');
  });
});

describe('#659 restarting (not just starting) the restored server', () => {
  it('POSTs /restart, not /start, when "Запустить сервер" is clicked', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: init?.method });
        if (url === '/api/v1/servers/archive/abc' && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' },
              }),
              { status: 200 },
            ),
          );
        }
        if (url === '/api/v1/servers/archive/abc/restore' && init?.method === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'new-1',
                archive_id: 'abc',
                slug: 'eu-main-restored',
                display_name: 'EU Main (restored)',
                status: 'pending',
              }),
              { status: 201 },
            ),
          );
        }
        if (url === '/api/v1/servers/new-1/install' && init?.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
        }
        if (url === '/api/v1/servers/new-1/restore-configs' && init?.method === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ok: true,
                files_restored: 3,
                files_skipped: 1,
                files_missing: 0,
                errors: [],
              }),
              { status: 200 },
            ),
          );
        }
        if (url === '/api/v1/servers/new-1/restart' && init?.method === 'POST') {
          return Promise.resolve(
            new Response(JSON.stringify({ status: 'restarting' }), {
              status: 200,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
      }),
    );
    await renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws?.onmessage?.({ data: JSON.stringify({ done: true, final: 'done' }) });
    });

    await screen.findByRole('button', { name: 'Запустить сервер' });
    await user.click(screen.getByRole('button', { name: 'Запустить сервер' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/v1/servers/new-1/restart' && c.method === 'POST'),
      ).toBe(true),
    );
    expect(calls.some((c) => c.url === '/api/v1/servers/new-1/start')).toBe(false);
  });
});

describe('#660 install socket closing without a done/error frame', () => {
  it('surfaces an error instead of leaving the wizard stuck on "Установка…"', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/archive/abc' && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' },
              }),
              { status: 200 },
            ),
          );
        }
        if (url === '/api/v1/servers/archive/abc/restore' && init?.method === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'new-1',
                archive_id: 'abc',
                slug: 'eu-main-restored',
                display_name: 'EU Main (restored)',
                status: 'pending',
              }),
              { status: 201 },
            ),
          );
        }
        if (url === '/api/v1/servers/new-1/install' && init?.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
      }),
    );
    await renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    // Server drops the connection (or replays only a terminal snapshot)
    // without ever sending a `done`/`error` frame.
    await act(async () => {
      ws?.onclose?.();
    });

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('раньше отчёта о завершении');
  });
});

// #664: the error stage used to be terminal, and rights were only discovered
// halfway through the wizard.
describe('#664 retry, open server and permission pre-check', () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  function stubApi(opts: { permissions: string[]; configsStatuses?: number[] }) {
    const configsStatuses = [...(opts.configsStatuses ?? [200])];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url === '/api/v1/me') return json({ permissions: opts.permissions });
        if (url === '/api/v1/servers/archive/abc') {
          return json({ server: { id: 'abc', display_name: 'EU Main', slug: 'eu-main' } });
        }
        if (url === '/api/v1/servers/archive/abc/restore') {
          return json(
            { id: 'new-1', archive_id: 'abc', slug: 's', display_name: 'n', status: 'p' },
            201,
          );
        }
        if (url === '/api/v1/servers/new-1/install') return json({});
        if (url === '/api/v1/servers/new-1/restore-configs') {
          const status = configsStatuses.shift() ?? 200;
          return json(
            { ok: true, files_restored: 1, files_skipped: 0, files_missing: 0, errors: [] },
            status,
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${method}`));
      }),
    );
    return calls;
  }

  it('disables the wizard and names the missing right', async () => {
    stubApi({ permissions: ['server:install'] });
    await renderPage();

    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' })).toBeDisabled(),
    );
    expect(screen.getByText(/Не хватает: config:edit/)).toBeInTheDocument();
  });

  it('keeps the wizard enabled when both rights are present', async () => {
    stubApi({ permissions: ['server:install', 'config:edit'] });
    await renderPage();

    await screen.findByLabelText(/^Идентификатор нового сервера/);
    expect(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' })).toBeEnabled();
    expect(screen.queryByText(/Недостаточно прав/)).toBeNull();
  });

  it('retries restore-configs from the error stage and offers to open the server', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    const calls = stubApi({
      permissions: ['server:install', 'config:edit'],
      configsStatuses: [403, 200],
    });
    await renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await act(async () => {
      MockWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({ done: true, final: 'done' }),
      });
    });

    await user.click(await screen.findByRole('button', { name: 'Повторить шаг' }));
    await screen.findByRole('button', { name: 'Запустить сервер' });
    expect(calls.filter((c) => c === 'POST /api/v1/servers/new-1/restore-configs')).toHaveLength(2);
    expect(calls.filter((c) => c === 'POST /api/v1/servers/new-1/install')).toHaveLength(1);
  });

  it('opens the created server from the error stage', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    stubApi({ permissions: ['server:install', 'config:edit'] });
    await renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText(/^Идентификатор нового сервера/);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Создать новый сервер из бэкапа' }));
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await act(async () => {
      MockWebSocket.instances[0]?.onclose?.();
    });

    await user.click(await screen.findByRole('button', { name: 'Открыть сервер' }));
    expect(routerPush).toHaveBeenCalledWith('/servers/new-1');
  });
});
