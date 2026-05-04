import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/configs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import ConfigsPage from './page';

describe('ConfigsPage', () => {
  it('is a valid React component', () => {
    expect(ConfigsPage).toBeDefined();
    expect(typeof ConfigsPage).toBe('function');
  });
});
