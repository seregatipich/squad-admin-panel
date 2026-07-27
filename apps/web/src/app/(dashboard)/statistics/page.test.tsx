import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/statistics'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/dynamic', () => ({ default: vi.fn(() => () => null) }));

import StatisticsPage from './page';

describe('StatisticsPage', () => {
  it('is a valid React component', () => {
    expect(StatisticsPage).toBeDefined();
    expect(typeof StatisticsPage).toBe('function');
  });
});
