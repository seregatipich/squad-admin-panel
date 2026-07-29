import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => false }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => '/all-players'),
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
  it('all-players/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/all-players/page');
    expect(mod.default).toBeDefined();
  });

  // The player card mounts 27 sections, so this dynamic import transforms a large
  // module graph. It finishes in well under a second alone, but exceeds vitest's 5s
  // default under a full parallel run. The assertion is unchanged — only the
  // allowance for transform cost, matching the 15s used by this package's heavier
  // component suites.
  it('all-players/[id]/page exports default', async () => {
    const mod = await import('../../src/app/(dashboard)/all-players/[id]/page');
    expect(mod.default).toBeDefined();
  }, 15_000);
});
