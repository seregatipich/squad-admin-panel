// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

let capturedOnStart: ((serverIds: string[]) => Promise<void>) | undefined;
vi.mock('@/components/DepotUpdateModal', () => ({
  DepotUpdateModal: (props: { onStart: (serverIds: string[]) => Promise<void> }) => {
    capturedOnStart = props.onStart;
    return null;
  },
}));
vi.mock('@/components/UpdateProgressModal', () => ({ UpdateProgressModal: () => null }));
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  capturedOnStart = undefined;
});

describe('DashboardPage', () => {
  it('is a valid React component', () => {
    expect(DashboardPage).toBeDefined();
    expect(typeof DashboardPage).toBe('function');
  });

  it('posts server_ids (not stop_server_ids) to /api/v1/depot/update on start', async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/ready') {
          return {
            ok: true,
            json: async () => ({ status: 'ok', checks: {} }),
          } as Response;
        }
        if (url === '/api/v1/depot/update') {
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return { ok: true, json: async () => ({ status: 'started' }) } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedOnStart).toBeDefined();
    await act(async () => {
      await capturedOnStart?.(['server-1', 'server-2']);
    });

    expect(capturedBody).toEqual({ server_ids: ['server-1', 'server-2'] });
  });
});
