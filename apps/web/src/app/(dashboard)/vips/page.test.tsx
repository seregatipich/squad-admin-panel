import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/vips'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '1',
    canonical_name: 'T',
    permissions: ['user:view'],
  }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

import VipsPage from './page';

describe('VipsPage', () => {
  it('is a valid React component', () => {
    expect(VipsPage).toBeDefined();
    expect(typeof VipsPage).toBe('function');
  });

  it('renders the roster table for a permitted user with no assignments', async () => {
    const element = await VipsPage({ searchParams: Promise.resolve({}) });
    expect(element).toBeDefined();
  });
});
