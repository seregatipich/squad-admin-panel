import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/tokens'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import TokensPage from './page';

describe('TokensPage', () => {
  it('is a valid React component', () => {
    expect(TokensPage).toBeDefined();
    expect(typeof TokensPage).toBe('function');
  });
});
