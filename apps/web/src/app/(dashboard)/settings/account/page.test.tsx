import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/account'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import AccountPage from './page';

describe('AccountPage', () => {
  it('is a valid React component', () => {
    expect(AccountPage).toBeDefined();
    expect(typeof AccountPage).toBe('function');
  });
});
