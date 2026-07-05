import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/clans'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClansPage from './page';

describe('ClansPage', () => {
  it('is a valid React component', () => {
    expect(ClansPage).toBeDefined();
    expect(typeof ClansPage).toBe('function');
  });
});
