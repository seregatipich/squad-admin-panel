import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/issues'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import IssuesPage from './page';

describe('IssuesPage', () => {
  it('is a valid React component', () => {
    expect(IssuesPage).toBeDefined();
    expect(typeof IssuesPage).toBe('function');
  });
});
