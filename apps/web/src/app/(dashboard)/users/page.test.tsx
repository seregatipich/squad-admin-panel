// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function stubFetch(users: unknown[], permissions: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
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
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
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
