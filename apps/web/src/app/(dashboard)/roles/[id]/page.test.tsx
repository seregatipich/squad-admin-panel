import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/roles/1'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import LegacyRoleEditPage from './page';

describe('LegacyRoleEditPage', () => {
  it('is a valid function component', () => {
    expect(LegacyRoleEditPage).toBeDefined();
    expect(typeof LegacyRoleEditPage).toBe('function');
  });
});
