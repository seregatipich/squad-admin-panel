// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/A2SIndicator', () => ({ A2SIndicator: () => null }));
vi.mock('@/components/AdminsCfgDriftBanner', () => ({ AdminsCfgDriftBanner: () => null }));
vi.mock('@/components/BroadcastComposer', () => ({ BroadcastComposer: () => null }));
vi.mock('@/components/CrashBadge', () => ({ CrashBadge: () => null }));
vi.mock('@/components/ForceStopDialog', () => ({ ForceStopDialog: () => null }));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));
vi.mock('@/components/ServerLogFiles', () => ({ ServerLogFiles: () => null }));
vi.mock('./ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('./live-players', () => ({ LivePlayers: () => null }));
vi.mock('./map-widget', () => ({ MapWidget: () => null }));
vi.mock('./SeedCallButton', () => ({ SeedCallButton: () => null }));
vi.mock('./SeedingBadge', () => ({ SeedingBadge: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));
vi.mock('@/lib/ws-backoff', () => ({ nextBackoffMs: vi.fn(() => 1000) }));

let latestProgressModalProps:
  | { open: boolean; onDone?: (final: 'done' | 'error', error?: string) => void }
  | undefined;
vi.mock('@/components/UpdateProgressModal', () => ({
  UpdateProgressModal: (props: {
    open: boolean;
    onDone?: (final: 'done' | 'error', error?: string) => void;
  }) => {
    latestProgressModalProps = props;
    return null;
  },
}));

import ServerDetailPage from './page';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function serverResponseFixture(status: string) {
  return {
    server: {
      id: SERVER_ID,
      display_name: 'Test Server',
      slug: 'test-server',
      status,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    settings: null,
    rcon_status: { state: 'not_polled' },
    container: null,
    host: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  latestProgressModalProps = undefined;
});

describe('ServerDetailPage', () => {
  it('is a valid React component', () => {
    expect(ServerDetailPage).toBeDefined();
    expect(typeof ServerDetailPage).toBe('function');
  });

  it('starts an update, opens the progress modal, and resets on completion', async () => {
    let updateCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `/api/v1/servers/${SERVER_ID}`) {
          return { ok: true, json: async () => serverResponseFixture('stopped') } as Response;
        }
        if (url === '/api/v1/me') {
          return {
            ok: true,
            json: async () => ({ squad_permissions: [], permissions: [] }),
          } as Response;
        }
        if (url === `/api/v1/servers/${SERVER_ID}/update` && init?.method === 'POST') {
          updateCalled = true;
          return {
            ok: true,
            json: async () => ({ status: 'started', server_id: SERVER_ID }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ServerDetailPage params={Promise.resolve({ id: SERVER_ID })} />
        </Suspense>,
      );
    });

    const updateButton = await screen.findByRole('button', { name: 'Обновить игру' });
    fireEvent.click(updateButton);

    await waitFor(() => expect(updateCalled).toBe(true));
    await waitFor(() => expect(latestProgressModalProps?.open).toBe(true));

    expect(await screen.findByText('Обновление... (открыть лог)')).toBeInTheDocument();

    act(() => latestProgressModalProps?.onDone?.('done'));

    await waitFor(() =>
      expect(screen.queryByText('Обновление... (открыть лог)')).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: 'Обновить игру' })).toBeInTheDocument();
  });
});
