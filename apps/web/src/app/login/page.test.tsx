import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/login'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import LoginPage from './page';

describe('LoginPage', () => {
  it('is a valid React component', () => {
    expect(LoginPage).toBeDefined();
    expect(typeof LoginPage).toBe('function');
  });
});
