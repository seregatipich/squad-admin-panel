import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/roles'),
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

describe('roles pages', () => {
  it('roles/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/roles/page');
    expect(mod.default).toBeDefined();
  });

  it('roles/[id]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/roles/[id]/page');
    expect(mod.default).toBeDefined();
  });

  it('roles/new/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/roles/new/page');
    expect(mod.default).toBeDefined();
  });
});
