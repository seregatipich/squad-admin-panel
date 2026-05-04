import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/groups'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@squad/shared-config/role-colors', () => ({
  ROLE_COLORS: [],
}));

import GroupsPage from './page';

describe('GroupsPage', () => {
  it('is a valid React component', () => {
    expect(GroupsPage).toBeDefined();
    expect(typeof GroupsPage).toBe('function');
  });
});
