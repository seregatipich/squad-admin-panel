import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ArchiveDetailPage from './page';

describe('ArchiveDetailPage', () => {
  it('is a valid React component', () => {
    expect(ArchiveDetailPage).toBeDefined();
    expect(typeof ArchiveDetailPage).toBe('function');
  });
});
