// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DiscordRoleMappingsSection, { roleSyncStatusText } from './DiscordRoleMappingsSection';

const ROLES = [
  { id: 'role-vip', name: 'VIP', color: 'sky', is_system_role: false },
  { id: 'role-mod', name: 'Moderator', color: 'amber', is_system_role: false },
  { id: 'role-owner', name: 'Owner', color: 'red', is_system_role: true },
];

const MAPPING = {
  id: 'map-1',
  role_id: 'role-vip',
  role_name: 'VIP',
  discord_role_id: '700000000000000001',
  source: 'panel_role',
  enabled: true,
  created_at: '2026-07-27T10:00:00.000Z',
  updated_at: '2026-07-27T10:00:00.000Z',
};

interface Routes {
  list?: () => Promise<Response>;
  create?: (body: unknown) => Promise<Response>;
  patch?: (body: unknown) => Promise<Response>;
  remove?: () => Promise<Response>;
  reconcile?: () => Promise<Response>;
}

function mockFetch(routes: Routes = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/role-mappings/reconcile') && init?.method === 'POST') {
      return routes.reconcile
        ? routes.reconcile()
        : Promise.resolve(new Response(JSON.stringify({ enqueued: true }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/integrations/discord/role-mappings') && init?.method === 'POST') {
      return routes.create
        ? routes.create(body)
        : Promise.resolve(new Response(JSON.stringify(MAPPING), { status: 201 }));
    }
    if (url.includes('/role-mappings/') && init?.method === 'PATCH') {
      return routes.patch
        ? routes.patch(body)
        : Promise.resolve(
            new Response(JSON.stringify({ ...MAPPING, enabled: false }), { status: 200 }),
          );
    }
    if (url.includes('/role-mappings/') && init?.method === 'DELETE') {
      return routes.remove
        ? routes.remove()
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/integrations/discord/role-mappings')) {
      return routes.list
        ? routes.list()
        : Promise.resolve(
            new Response(JSON.stringify({ items: [MAPPING], status: null }), { status: 200 }),
          );
    }
    if (url.endsWith('/api/v1/roles')) {
      return Promise.resolve(new Response(JSON.stringify(ROLES), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('roleSyncStatusText', () => {
  it('explains a missing Manage Roles permission in Russian', () => {
    expect(
      roleSyncStatusText({
        state: 'error',
        reason: 'missing_permissions',
        message: 'raw',
        checked_at: '2026-07-27T10:00:00.000Z',
      }),
    ).toBe('У бота нет права Manage Roles в Discord-гильдии — роли не выдаются.');
  });

  it('falls back to the worker message for any other error reason', () => {
    expect(
      roleSyncStatusText({
        state: 'error',
        reason: 'http_error',
        message: 'Discord вернул 500',
        checked_at: '2026-07-27T10:00:00.000Z',
      }),
    ).toBe('Discord вернул 500');
  });

  it('returns null when the worker reports a healthy sync', () => {
    expect(
      roleSyncStatusText({
        state: 'ok',
        reason: null,
        message: null,
        checked_at: '2026-07-27T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null when the worker has never reported', () => {
    expect(roleSyncStatusText(null)).toBeNull();
  });
});

describe('DiscordRoleMappingsSection', () => {
  it('renders the existing mappings with the panel role name and Discord role id', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordRoleMappingsSection />);

    expect(await screen.findByText('Синхронизация ролей')).toBeInTheDocument();
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    expect(await screen.findByText('700000000000000001')).toBeInTheDocument();
  });

  it('documents that only panel roles are mapped today', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordRoleMappingsSection />);

    expect(await screen.findByText(/Источник — роль панели.*лидерборд/i)).toBeInTheDocument();
  });

  it('creates a mapping from the role select and the Discord role id field', async () => {
    const created: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        create: (body) => {
          created.push(body);
          return Promise.resolve(new Response(JSON.stringify(MAPPING), { status: 201 }));
        },
      }),
    );
    render(<DiscordRoleMappingsSection />);

    const select = await screen.findByLabelText('Роль панели');
    await userEvent.selectOptions(select, 'role-mod');
    await userEvent.type(await screen.findByLabelText('ID роли Discord'), '700000000000000002');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    await waitFor(() =>
      expect(created).toEqual([{ role_id: 'role-mod', discord_role_id: '700000000000000002' }]),
    );
  });

  it('surfaces the API error code when creating a duplicate mapping', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        create: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: 'role_mapping_exists' }), { status: 409 }),
          ),
      }),
    );
    render(<DiscordRoleMappingsSection />);

    await userEvent.selectOptions(await screen.findByLabelText('Роль панели'), 'role-mod');
    await userEvent.type(await screen.findByLabelText('ID роли Discord'), '700000000000000002');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    await waitFor(() =>
      expect(screen.getByText('Для этой роли панели маппинг уже существует')).toBeInTheDocument(),
    );
  });

  it('toggles a mapping off through PATCH', async () => {
    const patched: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        patch: (body) => {
          patched.push(body);
          return Promise.resolve(
            new Response(JSON.stringify({ ...MAPPING, enabled: false }), { status: 200 }),
          );
        },
      }),
    );
    render(<DiscordRoleMappingsSection />);

    // The enable control is a real switch, so it reports its own on/off state
    // to a screen reader instead of relying on the word next to it.
    const toggle = await screen.findByRole('switch', {
      name: 'Выдавать роль Discord для «VIP»',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    await waitFor(() => expect(patched).toEqual([{ enabled: false }]));
  });

  it('deletes a mapping', async () => {
    let deleted = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        remove: () => {
          deleted++;
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        },
      }),
    );
    render(<DiscordRoleMappingsSection />);

    // Each row's delete button names the mapping it deletes — with several
    // rows on screen, five buttons all called "Удалить" tell a screen-reader
    // user nothing about which one they are on.
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить маппинг «VIP»' }));
    await waitFor(() => expect(deleted).toBe(1));
  });

  it('requests a reconcile run on demand', async () => {
    let reconciled = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        reconcile: () => {
          reconciled++;
          return Promise.resolve(new Response(JSON.stringify({ enqueued: true }), { status: 200 }));
        },
      }),
    );
    render(<DiscordRoleMappingsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Синхронизировать сейчас' }));
    await waitFor(() => expect(reconciled).toBe(1));
    await waitFor(() =>
      expect(screen.getByText('Синхронизация поставлена в очередь')).toBeInTheDocument(),
    );
  });

  it('shows the worker error banner instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        list: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                items: [MAPPING],
                status: {
                  state: 'error',
                  reason: 'missing_permissions',
                  message: 'raw',
                  checked_at: '2026-07-27T10:00:00.000Z',
                },
              }),
              { status: 200 },
            ),
          ),
      }),
    );
    render(<DiscordRoleMappingsSection />);

    expect(
      await screen.findByText(
        'У бота нет права Manage Roles в Discord-гильдии — роли не выдаются.',
      ),
    ).toBeInTheDocument();
  });

  it('hides itself entirely when the API answers 403', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        list: () =>
          Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      }),
    );
    const { container } = render(<DiscordRoleMappingsSection />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('does not offer the Owner role as a mapping target', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<DiscordRoleMappingsSection />);

    const select = (await screen.findByLabelText('Роль панели')) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toContain('Moderator');
    expect(options).not.toContain('Owner');
  });
});
