import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/events'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import EventsPage from './page';

describe('EventsPage', () => {
  it('is a valid React component', () => {
    expect(EventsPage).toBeDefined();
    expect(typeof EventsPage).toBe('function');
  });
});
