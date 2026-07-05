import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/notes'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import NotesFeedPage from './page';

describe('NotesFeedPage', () => {
  it('is a valid React component', () => {
    expect(NotesFeedPage).toBeDefined();
    expect(typeof NotesFeedPage).toBe('function');
  });
});
