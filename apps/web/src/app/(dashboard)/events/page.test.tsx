import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/events'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import EventsPage from './page';

describe('EventsPage', () => {
  it('is a valid React component', () => {
    expect(EventsPage).toBeDefined();
    expect(typeof EventsPage).toBe('function');
  });
});
