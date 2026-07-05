import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/alerts'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AlertsPage from './page';

describe('AlertsPage', () => {
  it('is a valid React component', () => {
    expect(AlertsPage).toBeDefined();
    expect(typeof AlertsPage).toBe('function');
  });
});
