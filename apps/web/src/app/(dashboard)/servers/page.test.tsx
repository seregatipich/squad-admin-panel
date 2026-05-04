import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import ServersPage from './page';

describe('ServersPage', () => {
  it('is a valid React component', () => {
    expect(ServersPage).toBeDefined();
    expect(typeof ServersPage).toBe('function');
  });
});
