import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive/abc/restore'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import RestorePage from './page';

describe('RestorePage', () => {
  it('is a valid React component', () => {
    expect(RestorePage).toBeDefined();
    expect(typeof RestorePage).toBe('function');
  });
});
