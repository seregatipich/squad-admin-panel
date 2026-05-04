import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/users'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));

import UsersPage from './page';

describe('UsersPage', () => {
  it('is a valid React component', () => {
    expect(UsersPage).toBeDefined();
    expect(typeof UsersPage).toBe('function');
  });
});
