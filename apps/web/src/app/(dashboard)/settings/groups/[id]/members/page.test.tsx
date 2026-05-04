import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/groups/1/members'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@squad/shared-config/role-colors', () => ({
  ROLE_COLORS: [],
}));

import MembersPage from './page';

describe('MembersPage', () => {
  it('is a valid React component', () => {
    expect(MembersPage).toBeDefined();
    expect(typeof MembersPage).toBe('function');
  });
});
