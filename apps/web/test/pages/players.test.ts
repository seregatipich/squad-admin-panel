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
  requireSession: vi.fn().mockResolvedValue({
    player_id: '00000000-0000-0000-0000-000000000001',
    steam_id64: '1',
    canonical_name: 'Test',
    permissions: [],
  }),
  getSession: vi.fn().mockResolvedValue({
    player_id: '00000000-0000-0000-0000-000000000001',
    steam_id64: '1',
    canonical_name: 'Test',
    permissions: [],
  }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('../../src/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));

describe('players pages', () => {
  it('players/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/players/page');
    expect(mod.default).toBeDefined();
  });

  it('players/[id]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/players/[id]/page');
    expect(mod.default).toBeDefined();
  });
});
