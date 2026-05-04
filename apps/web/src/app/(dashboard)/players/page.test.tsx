import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/players'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import PlayersPage from './page';

describe('PlayersPage', () => {
  it('is a valid React component', () => {
    expect(PlayersPage).toBeDefined();
    expect(typeof PlayersPage).toBe('function');
  });
});
