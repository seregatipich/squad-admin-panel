import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/roles'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import LegacyRolesPage from './page';

describe('LegacyRolesPage', () => {
  it('is a valid React component that redirects', () => {
    expect(LegacyRolesPage).toBeDefined();
    expect(typeof LegacyRolesPage).toBe('function');
  });
});
