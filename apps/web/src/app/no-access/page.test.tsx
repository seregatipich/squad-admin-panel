import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/no-access'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import NoAccessPage from './page';

describe('NoAccessPage', () => {
  it('is a valid React component', () => {
    expect(NoAccessPage).toBeDefined();
    expect(typeof NoAccessPage).toBe('function');
  });
});
