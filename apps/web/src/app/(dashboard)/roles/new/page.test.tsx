import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/roles/new'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import LegacyRoleCreatePage from './page';

describe('LegacyRoleCreatePage', () => {
  it('is a valid function component', () => {
    expect(LegacyRoleCreatePage).toBeDefined();
    expect(typeof LegacyRoleCreatePage).toBe('function');
  });
});
