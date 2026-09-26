// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/users'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import UsersPage from './page';

const TEST_TIMEOUT_MS = 15_000;

describe('UsersPage', () => {
  it('is a valid React component', () => {
    expect(UsersPage).toBeDefined();
    expect(typeof UsersPage).toBe('function');
  });
});

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'player-alpha',
    steam_id64: '76561197999979001',
    canonical_name: 'Связанный',
    last_seen_at: '2026-07-20T10:30:00.000Z',
    role: { id: 'role-1', name: 'Admin', color: 'red', is_system_role: false },
    role_expires_at: null,
    role_comment: null,
    discord_linked: true,
    ...overrides,
  };
}

/** Every `DELETE …/role` the page sent, in order — the unassign requests. */
type RoleDeleteReply = { status: number; body?: unknown };

function stubFetch(
  users: unknown[],
  permissions: string[] = [],
  roleDelete: RoleDeleteReply = { status: 204 },
): { roleDeletes: string[] } {
  const roleDeletes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/v1/users')) {
        return Promise.resolve(new Response(JSON.stringify(users), { status: 200 }));
      }
      if (url.startsWith('/api/v1/me')) {
        return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
      }
      if (url.startsWith('/api/v1/roles')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (url.startsWith('/api/v1/players/') && init?.method === 'DELETE') {
        roleDeletes.push(url);
        return Promise.resolve(
          new Response(roleDelete.body === undefined ? null : JSON.stringify(roleDelete.body), {
            status: roleDelete.status,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  return { roleDeletes };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UsersPage Discord badge (DISCORD-4)', () => {
  it(
    'marks a linked panel user with the Discord badge',
    async () => {
      stubFetch([userRow()]);
      render(<UsersPage />);

      await screen.findByText('Связанный');
      expect(screen.getByText('Discord')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders no Discord badge for an unlinked panel user',
    async () => {
      stubFetch([
        userRow({ id: 'player-beta', canonical_name: 'Без Discord', discord_linked: false }),
      ]);
      render(<UsersPage />);

      await screen.findByText('Без Discord');
      expect(screen.queryByText('Discord')).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('UsersPage role assignment', () => {
  it('renders a date-only picker and explains the optional comment', async () => {
    stubFetch([], ['user:manage_roles']);
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Назначить роль игроку' }));

    expect(
      screen.getByRole('button', { name: 'Открыть календарь срока действия' }),
    ).toHaveTextContent('ДД/ММ/ГГГГ');
    expect(screen.getByPlaceholderText('Например: VIP по заявке')).toHaveAccessibleDescription(
      /причина выдачи видна другим администраторам/i,
    );
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});

describe('UsersPage role removal', () => {
  it('asks for confirmation in a dialog and only then sends the request', async () => {
    const { roleDeletes } = stubFetch([userRow()], ['user:manage_roles']);
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));

    const confirm = await screen.findByRole('button', { name: 'Снять роль' });
    expect(
      screen.getByText(
        'Пользователь «Связанный» потеряет доступ к панели. Роль можно выдать заново в любой момент.',
      ),
    ).toBeInTheDocument();
    expect(roleDeletes).toHaveLength(0);

    fireEvent.click(confirm);
    await waitFor(() => expect(roleDeletes).toEqual(['/api/v1/players/player-alpha/role']));
  });

  it('sends nothing when the confirmation is dismissed', async () => {
    const { roleDeletes } = stubFetch([userRow()], ['user:manage_roles']);
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));
    await screen.findByRole('button', { name: 'Снять роль' });

    const [cancel] = screen.getAllByRole('button', { name: 'Отмена' });
    fireEvent.click(cancel as HTMLElement);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Снять роль' })).not.toBeInTheDocument(),
    );
    expect(roleDeletes).toHaveLength(0);
  });

  it('explains the last-owner refusal instead of leaving the row unchanged', async () => {
    stubFetch([userRow()], ['user:manage_roles'], {
      status: 409,
      body: { error: 'cannot_remove_last_owner' },
    });
    render(<UsersPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Снять роль' }));

    expect(
      await screen.findByText(
        'Вы единственный Owner. Сначала выдайте роль Owner другому пользователю.',
      ),
    ).toBeInTheDocument();
  });
});
