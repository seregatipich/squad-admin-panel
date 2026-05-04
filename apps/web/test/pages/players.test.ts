import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/players'),
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

describe('players pages', () => {
  it('players/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/players/page');
    expect(mod.default).toBeDefined();
  });

  it('players/[steam_id64]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/players/[steam_id64]/page');
    expect(mod.default).toBeDefined();
  });
});
