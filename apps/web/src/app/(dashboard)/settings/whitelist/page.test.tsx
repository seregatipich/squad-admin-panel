// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WhitelistSettingsPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function mockFetch(
  opts: {
    permissions?: string[];
    settingsNetworkError?: boolean;
    meStatus?: number;
    rolesStatus?: number;
    importReply?: { status: number; body: unknown };
  } = {},
) {
  const permissions = opts.permissions ?? ['whitelist:view', 'whitelist:edit'];
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/whitelist/settings') && opts.settingsNetworkError) {
      return Promise.reject(new Error('offline'));
    }
    if (url.includes('/api/v1/whitelist/applications/settings')) {
      return Promise.resolve(
        new Response(JSON.stringify({ enabled: false, default_days: null }), { status: 200 }),
      );
    }
    if (url.includes('/api/v1/whitelist/applications')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 20 }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith('/api/v1/whitelist/import') && init?.method === 'POST' && opts.importReply) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.importReply.body), { status: opts.importReply.status }),
      );
    }
    if (url.endsWith('/api/v1/whitelist/settings')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ whitelist_role_id: 'role-vip', whitelist_role_name: 'VIP' }),
          {
            status: 200,
          },
        ),
      );
    }
    if (url.endsWith('/api/v1/roles')) {
      if (opts.rolesStatus && opts.rolesStatus !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden' }), { status: opts.rolesStatus }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.endsWith('/api/v1/me')) {
      if (opts.meStatus && opts.meStatus !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden' }), { status: opts.meStatus }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WhitelistSettingsPage', () => {
  it(
    'renders the whitelist role section and the applications section',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<WhitelistSettingsPage />);
      expect(await screen.findByRole('heading', { name: 'Whitelist' })).toBeInTheDocument();
      expect(await screen.findByText(/заявки на whitelist/i)).toBeInTheDocument();
      expect(screen.getByText(/приём заявок открыт/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the portal save control when the user lacks whitelist:edit',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ permissions: ['whitelist:view'] }));
      render(<WhitelistSettingsPage />);
      await screen.findByText(/заявки на whitelist/i);
      expect(screen.queryByRole('button', { name: /сохранить настройки портала/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers the whitelist role picker only with user:manage_roles (#8)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ permissions: ['whitelist:view', 'whitelist:edit'] }));
      render(<WhitelistSettingsPage />);
      expect(
        await screen.findByText(/Выбрать роль whitelist может только пользователь с правом/),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Роль для whitelist')).toBeNull();
      cleanup();

      vi.stubGlobal(
        'fetch',
        mockFetch({ permissions: ['whitelist:view', 'whitelist:edit', 'user:manage_roles'] }),
      );
      render(<WhitelistSettingsPage />);
      expect(await screen.findByLabelText('Роль для whitelist')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a retryable network-error banner instead of hanging on the skeleton (#730)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ settingsNetworkError: true }));
      render(<WhitelistSettingsPage />);
      expect(await screen.findByText(/Ошибка сети: offline/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a failed /api/v1/me response instead of hanging on the skeleton (#730)',
    async () => {
      vi.stubGlobal('fetch', mockFetch({ meStatus: 500 }));
      render(<WhitelistSettingsPage />);
      expect(await screen.findByText('Не удалось загрузить настройки: 500')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'explains a 403 on /api/v1/roles instead of silently leaving the role picker empty (#730)',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          permissions: ['whitelist:view', 'whitelist:edit', 'user:manage_roles'],
          rolesStatus: 403,
        }),
      );
      render(<WhitelistSettingsPage />);
      expect(
        await screen.findByText('Список ролей недоступен: нужно право «Просмотр ролей».'),
      ).toBeInTheDocument();
      // A settings-load error from the parallel settings fetch must not be
      // masked, and vice versa — the 403 here shouldn't produce one either.
      expect(screen.queryByText(/Не удалось выполнить запрос/)).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'explains a too_many_rows import failure in Russian with the row limit',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          importReply: { status: 413, body: { error: 'too_many_rows', max_rows: 500 } },
        }),
      );
      render(<WhitelistSettingsPage />);
      const textarea = await screen.findByRole('textbox', { name: /csv/i });
      fireEvent.change(textarea, { target: { value: 'steam_id64\n76561198000000001' } });
      fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }));

      expect(
        await screen.findByText('Ошибка импорта: в файле слишком много строк (максимум 500)'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never prints an object error body as [object Object]',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ importReply: { status: 400, body: { error: { code: 'x' } } } }),
      );
      render(<WhitelistSettingsPage />);
      const textarea = await screen.findByRole('textbox', { name: /csv/i });
      fireEvent.change(textarea, { target: { value: 'a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }));

      expect(
        await screen.findByText('Ошибка импорта: Сервер вернул ошибку (код 400).'),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
