// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression (Wave 11 clarification of #45 / SRV-6, depot workflow #44): the
// dashboard "update depot" modal used to POST the operator's server-stop
// selection under `stop_server_ids`, a key the API silently ignored — so the
// shared depot was rewritten while those servers were still running. This test
// drives the real modal → page `onStart` wiring and asserts the request body
// carries `server_ids` (the API contract) and never the legacy key.

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/dashboard'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));
// Heavy sibling widgets do their own fetching/streaming; stub them out so the
// only fetch traffic we assert on is the dashboard's own load + depot POST.
vi.mock('./analytics-panel', () => ({ AnalyticsPanel: () => null }));
vi.mock('./vote-analytics-panel', () => ({ VoteAnalyticsPanel: () => null }));
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

const RUNNING_SERVER = {
  id: '01920000-0000-7000-8000-000000000abc',
  display_name: 'Depot Flow Server',
  slug: 'depot-flow',
  status: 'running',
  player_count: 12,
  rcon_state: 'connected',
  last_poll_at: new Date().toISOString(),
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockDashboardFetch() {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/depot/update') {
      return jsonResponse({ status: 'started', started_at: 'now', servers_to_stop: [] });
    }
    if (url.startsWith('/api/v1/servers')) return jsonResponse({ items: [RUNNING_SERVER] });
    if (url === '/api/v1/host/bridge-status') {
      return jsonResponse({ connected: true, version: 'test', hostname: 'h' });
    }
    if (url === '/api/v1/host/info') {
      return jsonResponse({
        hostname: 'h',
        os_name: 'Ubuntu',
        os_version: '24.04',
        kernel: '6.8',
        arch: 'x86_64',
        cpu_model: 'test-cpu',
        cpu_cores: 8,
        ram_total_bytes: 16 * 1024 ** 3,
        uptime_seconds: 3600,
        docker_version: 'Docker 27',
        ip_addresses: ['10.0.0.1'],
      });
    }
    if (url === '/api/v1/host/metrics') {
      return jsonResponse({
        cpu_percent: 1,
        ram_used_bytes: 1024 ** 3,
        ram_total_bytes: 16 * 1024 ** 3,
        disk_used_bytes: 10 * 1024 ** 3,
        disk_total_bytes: 100 * 1024 ** 3,
        net_rx_bytes_per_sec: 0,
        net_tx_bytes_per_sec: 0,
        load_avg_1m: 0,
        load_avg_5m: 0,
        load_avg_15m: 0,
        sampled_at: new Date().toISOString(),
      });
    }
    if (url.startsWith('/api/v1/audit')) return jsonResponse({ items: [] });
    if (url === '/ready') return jsonResponse({ status: 'ok', checks: {} });
    if (url === '/api/v1/health/workers') return jsonResponse({ items: [] });
    if (url.startsWith('/api/v1/host/disk-usage')) return jsonResponse({});
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('dashboard depot update flow', () => {
  it('POSTs the selected servers under server_ids, not the legacy stop_server_ids', async () => {
    const fetchSpy = mockDashboardFetch();
    render(<DashboardPage />);

    // Wait until the initial load resolves and the running server is on screen.
    await waitFor(() => expect(screen.getAllByText('Depot Flow Server').length).toBeGreaterThan(0));

    // Open the depot update modal and select the running server.
    fireEvent.click(screen.getByRole('button', { name: 'Обновить Squad' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Начать обновление' }));

    // The depot POST must have fired with the correct wire contract.
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([u]) => String(u) === '/api/v1/depot/update')).toBe(true),
    );
    const depotCall = fetchSpy.mock.calls.find(([u]) => String(u) === '/api/v1/depot/update');
    if (!depotCall) throw new Error('depot/update was never called');
    const body = JSON.parse((depotCall[1] as RequestInit).body as string);

    expect(body).toHaveProperty('server_ids', [RUNNING_SERVER.id]);
    expect(body).not.toHaveProperty('stop_server_ids');
  });
});
