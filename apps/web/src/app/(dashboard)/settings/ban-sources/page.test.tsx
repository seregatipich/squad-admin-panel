import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/ban-sources'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import BanSourcesPage from './page';

describe('BanSourcesPage', () => {
  it('is a valid React component', () => {
    expect(BanSourcesPage).toBeDefined();
    expect(typeof BanSourcesPage).toBe('function');
  });
});
