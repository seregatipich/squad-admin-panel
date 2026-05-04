import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ArchivePage from './page';

describe('ArchivePage', () => {
  it('is a valid React component', () => {
    expect(ArchivePage).toBeDefined();
    expect(typeof ArchivePage).toBe('function');
  });
});
