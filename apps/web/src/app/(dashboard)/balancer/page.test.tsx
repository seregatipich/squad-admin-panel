import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));

const redirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => redirect(...args),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/balancer'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

const requireSession = vi.fn();
vi.mock('@/lib/dal', () => ({
  requireSession: () => requireSession(),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('./BalancerBrowser', () => ({ BalancerBrowser: () => null }));

import BalancerPage from './page';

describe('BalancerPage', () => {
  it('is a valid React component', () => {
    expect(BalancerPage).toBeDefined();
    expect(typeof BalancerPage).toBe('function');
  });

  it('renders the review surface for a holder of balancer:view', async () => {
    redirect.mockClear();
    requireSession.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'T',
      permissions: ['balancer:view'],
    });

    const element = await BalancerPage();

    expect(element).toBeDefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects a session without balancer:view away from the page', async () => {
    redirect.mockClear();
    requireSession.mockResolvedValue({
      steam_id64: '1',
      canonical_name: 'T',
      permissions: ['player:view'],
    });

    await BalancerPage();

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });
});
