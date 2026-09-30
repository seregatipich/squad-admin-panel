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

import { UsersBrowser } from './UsersBrowser';

const TEST_TIMEOUT_MS = 15_000;

function userRow(id: string, name: string) {
  return {
    id,
    steam_id64: `7656119799997${id.length}`,
    canonical_name: name,
    last_seen_at: '2026-07-20T10:30:00.000Z',
    role: { id: 'role-1', name: 'Admin', color: 'red', is_system_role: false },
    role_expires_at: null,
    role_comment: null,
    discord_linked: false,
  };
}

function stubPagedFetch(): string[] {
  const userUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/v1/users')) {
        userUrls.push(url);
        const isSecondPage = url.includes('cursor=cursor-1');
        return Promise.resolve(
          new Response(
            JSON.stringify(
              isSecondPage ? [userRow('p-second', 'Второй')] : [userRow('p-first', 'Первый')],
            ),
            { status: 200, headers: isSecondPage ? {} : { 'x-next-cursor': 'cursor-1' } },
          ),
        );
      }
      if (url.startsWith('/api/v1/me')) {
        return Promise.resolve(new Response(JSON.stringify({ permissions: [] }), { status: 200 }));
      }
      if (url.startsWith('/api/v1/roles')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  return userUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UsersBrowser pagination (#357)', () => {
  it(
    'loads the next page on demand and hides the button on the last page',
    async () => {
      const userUrls = stubPagedFetch();
      render(<UsersBrowser />);

      await screen.findByText('Первый');
      expect(screen.queryByText('Второй')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));

      await screen.findByText('Второй');
      expect(screen.getByText('Первый')).toBeInTheDocument();
      expect(userUrls.at(-1)).toContain('cursor=cursor-1');
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
