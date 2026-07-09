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
  usePathname: vi.fn(() => '/suspects'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: requireSessionMock,
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('./SuspectsBrowser', () => ({ SuspectsBrowser: () => null }));

import SuspectsPage from './page';

describe('SuspectsPage', () => {
  it('is a valid async function component', () => {
    expect(SuspectsPage).toBeDefined();
    expect(typeof SuspectsPage).toBe('function');
  });

  it('redirects to /dashboard when the session lacks player:view', async () => {
    redirectMock.mockClear();
    requireSessionMock.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'NoAccess',
      permissions: [],
    });
    await SuspectsPage();
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });

  it('does not redirect when the session has player:view', async () => {
    redirectMock.mockClear();
    requireSessionMock.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'HasAccess',
      permissions: ['player:view'],
    });
    await SuspectsPage();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
