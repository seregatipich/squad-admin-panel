import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '76561198000000001',
    canonical_name: 'TestUser',
    permissions: ['servers.view'],
  }),
}));
vi.mock('@/components/connection-banner', () => ({
  ConnectionBanner: () => null,
}));
vi.mock('@/components/SidebarNav', () => ({
  SidebarNav: () => null,
}));
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null,
}));

import DashboardLayout from './layout';

describe('DashboardLayout', () => {
  it('is a valid async function component', () => {
    expect(DashboardLayout).toBeDefined();
    expect(typeof DashboardLayout).toBe('function');
  });
});
