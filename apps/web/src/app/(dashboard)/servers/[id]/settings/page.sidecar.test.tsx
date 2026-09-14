// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'srv-1' })) };
});
// Кнопки жизненного цикла проверяются в ServerControls.test.tsx.
vi.mock('./ServerControls', () => ({ ServerControls: () => null }));

import SettingsPage from './page';

const SETTINGS = {
  server_id: 'srv-1',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 80,
  tickrate: 50,
  multihome: null,
  extra_args: '',
  cpu_affinity: null,
  cpu_weight: null,
  niceness: null,
  memory_high_mb: null,
  memory_max_mb: null,
  io_weight: null,
  seed_live_at: 60,
  seed_hysteresis: 5,
  chat_commands_enabled: true,
  rules_text: null,
  archive_logs_to_backup: false,
};

/**
 * Same shape as the router in page.chat-commands.test.tsx: any URL the page
 * requests that is not stubbed here rejects, so an unexpected fetch fails loudly.
 */
function mockFetch(sidecar: Response | (() => Response)) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            server: { status: 'stopped', display_name: 'Test', tags: [] },
            settings: SETTINGS,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === '/api/v1/me') {
      return Promise.resolve(
        new Response(JSON.stringify({ squad_permissions: [] }), { status: 200 }),
      );
    }
    if (url === '/api/v1/servers/srv-1/sidecar') {
      return Promise.resolve(typeof sidecar === 'function' ? sidecar() : sidecar);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
  });
}

function statusResponse(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage SquadJS sidecar section (STATS-4 #71)', () => {
  it('renders the production mode and a connected heartbeat', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        statusResponse({
          server_id: 'srv-1',
          engine: 'squadjs2',
          mode: 'production',
          cutover: true,
          status: { state: 'connected', last_change: '2026-07-27T10:00:00.000Z' },
        }),
      ),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Интеграция SquadJS')).toBeInTheDocument();
    expect(await screen.findByText('Продакшен')).toBeInTheDocument();
    expect(screen.getByText('SquadJS2')).toBeInTheDocument();
    expect(screen.getByText('RCON подключён')).toBeInTheDocument();
  });

  it('renders the shadow mode with a disconnected heartbeat', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        statusResponse({
          server_id: 'srv-1',
          engine: 'rnsquadjs',
          mode: 'shadow',
          cutover: false,
          status: { state: 'disconnected', last_change: '2026-07-27T11:00:00.000Z' },
        }),
      ),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Теневой режим')).toBeInTheDocument();
    expect(screen.getByText('RNSquadJS (legacy)')).toBeInTheDocument();
    expect(screen.getByText('RCON отключён')).toBeInTheDocument();
  });

  it('shows "Нет сигнала" for legacy mode with no heartbeat', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        statusResponse({
          server_id: 'srv-1',
          engine: 'rnsquadjs',
          mode: 'legacy',
          cutover: false,
          status: null,
        }),
      ),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Штатный парсер')).toBeInTheDocument();
    // With no sidecar running, the engine assignment says nothing about what is
    // actually reading events.
    expect(screen.getByText('Не запущен')).toBeInTheDocument();
    expect(screen.getByText('Нет сигнала')).toBeInTheDocument();
  });

  it('hides the whole section when the status route 403s', async () => {
    vi.stubGlobal('fetch', mockFetch(statusResponse({ error: 'forbidden' }, 403)));
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    // The page itself has rendered; only the gated section is absent.
    expect(await screen.findByText('Чат-команды')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Интеграция SquadJS')).not.toBeInTheDocument());
  });

  it('hides the section when the status fetch rejects outright', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => {
        throw new Error('network down');
      }),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Чат-команды')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Интеграция SquadJS')).not.toBeInTheDocument());
  });
});
