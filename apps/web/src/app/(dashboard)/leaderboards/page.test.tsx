import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/leaderboards'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import LeaderboardsPage from './page';

describe('LeaderboardsPage', () => {
  it('is a valid React component', () => {
    expect(LeaderboardsPage).toBeDefined();
    expect(typeof LeaderboardsPage).toBe('function');
  });
});
