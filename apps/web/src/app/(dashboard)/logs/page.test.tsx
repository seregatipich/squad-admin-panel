import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/logs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '1',
    canonical_name: 'T',
    permissions: ['servers.view'],
  }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/components/LogList', () => ({ LogList: () => null }));

import LogsPage from './page';

describe('LogsPage', () => {
  it('is a valid React component', () => {
    expect(LogsPage).toBeDefined();
    expect(typeof LogsPage).toBe('function');
  });
});
