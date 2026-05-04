import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/servers'),
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

describe('servers pages', () => {
  it('servers/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/[id]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/[id]/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/[id]/configs/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/[id]/configs/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/[id]/events/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/[id]/events/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/new/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/new/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/new/_slug exports constants', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/new/_slug');
    expect(mod.CYRILLIC_TO_LATIN).toBeDefined();
  });

  it('servers/archive/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/archive/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/archive/[id]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/archive/[id]/page');
    expect(mod.default).toBeDefined();
  });

  it('servers/archive/[id]/restore/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/servers/archive/[id]/restore/page');
    expect(mod.default).toBeDefined();
  });
});
