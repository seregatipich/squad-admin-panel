import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/AdminsCfgDriftBanner', () => ({ AdminsCfgDriftBanner: () => null }));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));
vi.mock('@/lib/ws-backoff', () => ({ nextBackoffMs: vi.fn(() => 1000) }));

import ServerDetailPage from './page';

describe('ServerDetailPage', () => {
  it('is a valid React component', () => {
    expect(ServerDetailPage).toBeDefined();
    expect(typeof ServerDetailPage).toBe('function');
  });
});
