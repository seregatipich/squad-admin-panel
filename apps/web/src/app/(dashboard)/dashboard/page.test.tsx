import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '1',
    canonical_name: 'T',
    permissions: ['servers.view'],
  }),
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/components/DiskBreakdownModal', () => ({ DiskBreakdownModal: () => null }));
vi.mock('@/components/DockerPruneButton', () => ({ DockerPruneButton: () => null }));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/components/MetricHistoryModal', () => ({ MetricHistoryModal: () => null }));
vi.mock('@/components/RestartBridgeButton', () => ({ RestartBridgeButton: () => null }));
vi.mock('@/lib/format', () => ({
  formatBytes: vi.fn((v: number) => `${v}B`),
  formatBytesPerSec: vi.fn((v: number) => `${v}B/s`),
  formatPercent: vi.fn((v: number) => `${v}%`),
  formatUptime: vi.fn(() => '1d'),
  ratio: vi.fn(() => 0),
}));
vi.mock('@/lib/host-health', () => ({
  computeHostHealth: vi.fn(() => ({ level: 'healthy', reasons: [] })),
  thresholdTone: vi.fn(() => 'text-green-400'),
}));

import DashboardPage from './page';

describe('DashboardPage', () => {
  it('is a valid React component', () => {
    expect(DashboardPage).toBeDefined();
    expect(typeof DashboardPage).toBe('function');
  });
});
