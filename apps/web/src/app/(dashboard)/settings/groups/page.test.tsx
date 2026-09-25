// @vitest-environment jsdom
import { buildManagedSegmentBody } from '@squad/shared-config/admins-config';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/groups'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));

import GroupsPage from './page';

interface RoleFixture {
  id: string;
  name: string;
  squad_permissions: string[];
  assigned_users_count?: number;
  is_system_role?: boolean;
  panel_access?: boolean;
  can_view_ips?: boolean;
}

function makeRole(f: RoleFixture) {
  return {
    id: f.id,
    name: f.name,
    color: '#737373',
    description: null,
    is_system_role: f.is_system_role ?? false,
    panel_access: f.panel_access ?? false,
    can_view_ips: f.can_view_ips ?? false,
    can_assign_roles: false,
    can_edit_roles: false,
    can_manage_ban_sources: false,
    can_manage_clans: false,
    can_manage_economy: false,
    squad_permissions: f.squad_permissions,
    assigned_users_count: f.assigned_users_count ?? 0,
  };
}

const ALL_PERMS = ['role:create', 'role:edit', 'role:delete'];

/**
 * Mock fetch that serves GET /api/v1/roles and /api/v1/me, and records the
 * body of any POST /api/v1/roles (role creation) via `onPost`.
 */
function stubFetch(opts: {
  roles: ReturnType<typeof makeRole>[];
  permissions?: string[];
  onPost?: (body: Record<string, unknown>) => void;
  onPut?: (body: Record<string, unknown>) => void;
  onDelete?: (url: string) => void;
}) {
  const perms = opts.permissions ?? ALL_PERMS;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(new Response(JSON.stringify({ permissions: perms }), { status: 200 }));
    }
    if (url.endsWith('/api/v1/roles') && method === 'GET') {
      return Promise.resolve(new Response(JSON.stringify(opts.roles), { status: 200 }));
    }
    if (url.endsWith('/api/v1/roles') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onPost?.(body);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            makeRole({
              id: 'new',
              name: String(body.name),
              squad_permissions: (body.squad_permissions as string[]) ?? [],
            }),
          ),
          {
            status: 200,
          },
        ),
      );
    }
    const roleMatch = /\/api\/v1\/roles\/([^/]+)$/.exec(url);
    if (roleMatch && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      opts.onPut?.(body);
      const current = opts.roles.find((r) => r.id === roleMatch[1]) ?? opts.roles[0];
      return Promise.resolve(
        new Response(JSON.stringify({ ...current, ...body }), { status: 200 }),
      );
    }
    if (roleMatch && method === 'DELETE') {
      opts.onDelete?.(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GroupsPage', () => {
  it('is a valid React component', () => {
    expect(GroupsPage).toBeDefined();
    expect(typeof GroupsPage).toBe('function');
  });
});

describe('preset dropdown — copy permissions from another role (ROLE-6)', () => {
  it('lists every existing role as a copy-from preset option', async () => {
    stubFetch({
      roles: [
        makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: ['kick', 'ban'] }),
        makeRole({ id: 'r-mod', name: 'Moderator', squad_permissions: ['chat'] }),
      ],
    });
    render(<GroupsPage />);
    const select = (await screen.findByLabelText('Скопировать права из роли')) as HTMLSelectElement;
    const optionText = Array.from(select.options).map((o) => o.textContent);
    expect(optionText).toEqual([
      'Без пресета (пустая)',
      'Скопировать права из «Admin»',
      'Скопировать права из «Moderator»',
    ]);
  });

  it('creates a role whose squad_permissions are copied from the selected preset', async () => {
    const posted: Record<string, unknown>[] = [];
    stubFetch({
      roles: [
        makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: ['kick', 'ban'] }),
        makeRole({ id: 'r-mod', name: 'Moderator', squad_permissions: ['chat'] }),
      ],
      onPost: (b) => posted.push(b),
    });
    render(<GroupsPage />);
    const select = (await screen.findByLabelText('Скопировать права из роли')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'r-admin' } });
    fireEvent.click(screen.getByRole('button', { name: /создать роль/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.squad_permissions).toEqual(['kick', 'ban']);
  });

  it('creates an empty role when no preset is selected', async () => {
    const posted: Record<string, unknown>[] = [];
    stubFetch({
      roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: ['kick', 'ban'] })],
      onPost: (b) => posted.push(b),
    });
    render(<GroupsPage />);
    await screen.findByLabelText('Скопировать права из роли');
    fireEvent.click(screen.getByRole('button', { name: /создать роль/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.squad_permissions).toEqual([]);
  });
});

describe('realtime permission filter (ROLE-6)', () => {
  it('narrows the permission checkboxes to those matching the filter text', async () => {
    stubFetch({ roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: ['kick'] })] });
    render(<GroupsPage />);
    const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('section');
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);
    expect(scope.getByText('kick')).toBeInTheDocument();
    expect(scope.getByText('ban')).toBeInTheDocument();

    fireEvent.change(scope.getByLabelText('Фильтр прав'), { target: { value: 'kick' } });

    expect(scope.getByText('kick')).toBeInTheDocument();
    expect(scope.queryByText('ban')).not.toBeInTheDocument();
    expect(scope.queryByText('cameraman')).not.toBeInTheDocument();
  });

  it('shows an empty-result hint when nothing matches', async () => {
    stubFetch({ roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: [] })] });
    render(<GroupsPage />);
    const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('section');
    const scope = within(card as HTMLElement);
    fireEvent.change(scope.getByLabelText('Фильтр прав'), { target: { value: 'zzznope' } });
    expect(scope.getByText(/ничего не найдено по фильтру/i)).toBeInTheDocument();
    expect(scope.queryByText('kick')).not.toBeInTheDocument();
  });
});

describe('access flags — real switches (§6)', () => {
  it('flips the switch and saves the flag it names', async () => {
    const puts: Record<string, unknown>[] = [];
    stubFetch({
      roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: [] })],
      onPut: (b) => puts.push(b),
    });
    render(<GroupsPage />);

    const flag = await screen.findByRole('switch', { name: 'Доступ к панели' });
    expect(flag).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(flag);

    expect(flag).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 });
    expect(puts[0]).toEqual({ panel_access: true });
  });

  it('disables the dependent flags while panel access is off', async () => {
    stubFetch({ roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: [] })] });
    render(<GroupsPage />);

    expect(await screen.findByRole('switch', { name: 'Доступ к панели' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Видит историю IP' })).toBeDisabled();
  });

  it('clears every dependent flag when panel access is switched off', async () => {
    const puts: Record<string, unknown>[] = [];
    stubFetch({
      roles: [
        makeRole({
          id: 'r-admin',
          name: 'Admin',
          squad_permissions: [],
          panel_access: true,
          can_view_ips: true,
        }),
      ],
      onPut: (b) => puts.push(b),
    });
    render(<GroupsPage />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Доступ к панели' }));

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 });
    expect(puts[0]).toMatchObject({ panel_access: false, can_view_ips: false });
  });
});

describe('role deletion — confirmation with a typed challenge', () => {
  it('deletes nothing until the role name is typed back', async () => {
    const deleted: string[] = [];
    stubFetch({
      roles: [
        makeRole({
          id: 'r-admin',
          name: 'Admin',
          squad_permissions: [],
          assigned_users_count: 3,
        }),
      ],
      onDelete: (url) => deleted.push(url),
    });
    render(<GroupsPage />);

    const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('section');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Удалить роль' }));

    const dialog = await screen.findByRole('dialog', { name: 'Удалить роль' });
    expect(dialog).toHaveTextContent('3 пользователей');
    expect(deleted).toHaveLength(0);

    const confirm = within(dialog).getByRole('button', { name: 'Удалить роль' });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Введите имя роли, чтобы подтвердить'), {
      target: { value: 'Admin' },
    });
    expect(confirm).toBeEnabled();

    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(deleted).toEqual(['/api/v1/roles/r-admin']);
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const deleted: string[] = [];
    stubFetch({
      roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: [] })],
      onDelete: (url) => deleted.push(url),
    });
    render(<GroupsPage />);

    const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('section');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Удалить роль' }));

    const dialog = await screen.findByRole('dialog', { name: 'Удалить роль' });
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0]);
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleted).toHaveLength(0);
  });

  it('hides the delete control from an operator without role:delete', async () => {
    stubFetch({
      roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: [] })],
      permissions: ['role:view'],
    });
    render(<GroupsPage />);

    await screen.findByRole('heading', { name: 'Admin' });
    expect(screen.queryByRole('button', { name: 'Удалить роль' })).not.toBeInTheDocument();
  });
});

describe('Admins.cfg preview — shared generator, byte-identical (ROLE-6)', () => {
  it('renders exactly the bytes the shared buildManagedSegmentBody produces for the role', async () => {
    stubFetch({
      roles: [makeRole({ id: 'r-admin', name: 'Admin', squad_permissions: ['kick', 'ban'] })],
    });
    render(<GroupsPage />);
    const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('section');
    const scope = within(card as HTMLElement);
    const expected = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick', 'ban'] }],
      admins: [],
    }).body;
    const pre = scope.getByTestId('admins-cfg-preview');
    expect(pre.textContent).toBe(expected);
    // The shared generator sorts permissions and emits the managed-segment header.
    expect(pre.textContent).toContain('Group=Admin:ban,kick');
    expect(pre.textContent).toContain('//SQUAD-PANEL BEGIN');
  });

  it('emits header + END only (no Group= line) for a role without permissions', async () => {
    stubFetch({ roles: [makeRole({ id: 'r-empty', name: 'Пустая', squad_permissions: [] })] });
    render(<GroupsPage />);
    const card = (await screen.findByRole('heading', { name: 'Пустая' })).closest('section');
    const scope = within(card as HTMLElement);
    const expected = buildManagedSegmentBody({
      roles: [{ name: 'Пустая', squadPermissions: [] }],
      admins: [],
    }).body;
    expect(scope.getByTestId('admins-cfg-preview').textContent).toBe(expected);
    expect(scope.getByTestId('admins-cfg-preview').textContent).not.toContain('Group=');
  });
});
