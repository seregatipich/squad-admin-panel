import { describe, expect, it, vi } from 'vitest';

const { redirectMock, requireSessionMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  requireSessionMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/users'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: requireSessionMock,
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('./UsersBrowser', () => ({ UsersBrowser: () => null }));

import UsersPage from './page';

describe('UsersPage', () => {
  it('is a valid async function component', () => {
    expect(UsersPage).toBeDefined();
    expect(typeof UsersPage).toBe('function');
  });

  it('redirects to /dashboard when the session lacks user:view (#740)', async () => {
    redirectMock.mockClear();
    requireSessionMock.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'NoAccess',
      permissions: [],
    });
    await UsersPage();
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });

  it('does not redirect when the session has user:view', async () => {
    redirectMock.mockClear();
    requireSessionMock.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'HasAccess',
      permissions: ['user:view'],
    });
    await UsersPage();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
