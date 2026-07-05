import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/clans/x'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClanDetailPage from './page';

describe('ClanDetailPage', () => {
  it('is a valid React component', () => {
    expect(ClanDetailPage).toBeDefined();
    expect(typeof ClanDetailPage).toBe('function');
  });
});
