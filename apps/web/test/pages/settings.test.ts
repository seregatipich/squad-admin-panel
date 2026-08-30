import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/settings/account'),
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

describe('settings pages', () => {
  it('settings/account/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/(account)/settings/account/page');
    expect(mod.default).toBeDefined();
  });

  it('settings/groups/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/settings/groups/page');
    expect(mod.default).toBeDefined();
  });

  it('settings/groups/[id]/members/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/settings/groups/[id]/members/page');
    expect(mod.default).toBeDefined();
  });

  it('settings/tokens/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/settings/tokens/page');
    expect(mod.default).toBeDefined();
  });

  it('settings/integrations/media/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/settings/integrations/media/page');
    expect(mod.default).toBeDefined();
  });
});
