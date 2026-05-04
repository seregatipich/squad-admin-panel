import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
}));
vi.mock('../../src/lib/dal', () => ({
  requireSession: vi
    .fn()
    .mockResolvedValue({ steam_id64: '1', canonical_name: 'Test', permissions: [] }),
  getSession: vi
    .fn()
    .mockResolvedValue({ steam_id64: '1', canonical_name: 'Test', permissions: [] }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('../../src/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));

describe('layouts', () => {
  it('root layout exports default', async () => {
    const mod = await import('../../src/app/layout');
    expect(mod.default).toBeDefined();
  });

  it('dashboard layout exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/layout');
    expect(mod.default).toBeDefined();
  });
});
