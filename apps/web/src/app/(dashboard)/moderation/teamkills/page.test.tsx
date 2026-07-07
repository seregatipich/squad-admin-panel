import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/moderation/teamkills'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import TeamkillsPage from './page';

describe('TeamkillsPage', () => {
  it('is a valid React component', () => {
    expect(TeamkillsPage).toBeDefined();
    expect(typeof TeamkillsPage).toBe('function');
  });
});
