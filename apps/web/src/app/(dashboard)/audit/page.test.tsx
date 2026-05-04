import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/audit'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import AuditPage from './page';

describe('AuditPage', () => {
  it('is a valid React component', () => {
    expect(AuditPage).toBeDefined();
    expect(typeof AuditPage).toBe('function');
  });
});
