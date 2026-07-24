import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/automation'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AutomationPage from './page';

describe('AutomationPage', () => {
  it('is a valid React component', () => {
    expect(AutomationPage).toBeDefined();
    expect(typeof AutomationPage).toBe('function');
  });
});
