import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/players/b1e2c3d4-0000-0000-0000-000000000001'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));

import PlayerDetailPage from './page';

describe('PlayerDetailPage', () => {
  it('is a valid React component', () => {
    expect(PlayerDetailPage).toBeDefined();
    expect(typeof PlayerDetailPage).toBe('function');
  });
});
