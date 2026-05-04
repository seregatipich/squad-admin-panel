import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/new'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import NewServerPage from './page';

describe('NewServerPage', () => {
  it('is a valid React component', () => {
    expect(NewServerPage).toBeDefined();
    expect(typeof NewServerPage).toBe('function');
  });
});
