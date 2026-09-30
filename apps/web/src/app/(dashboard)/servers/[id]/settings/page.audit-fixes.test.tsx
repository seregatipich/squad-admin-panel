// @vitest-environment happy-dom
// Regression tests for issue #57 findings 651/652/653/654.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  rules_text: 'Не читерить.',
  archive_logs_to_backup: false,
};

function jsonRes(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#651 port fields disabled state', () => {
  it('leaves port fields enabled for a "failed" server, matching the API PORT_CHANGEABLE_STATUSES', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
          return jsonRes({
            server: { status: 'failed', display_name: 'Test', tags: [] },
            settings: SETTINGS,
          });
        }
        if (url === '/api/v1/me') return jsonRes({ squad_permissions: [] });
        if (url === '/api/v1/servers/srv-1/rnsquadjs') {
          return jsonRes({ server_id: 'srv-1', mode: 'legacy', cutover: false, status: null });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    const gamePort = await screen.findByRole('spinbutton', { name: 'Игровой порт' });
    expect(gamePort).toBeEnabled();
  });

  it('still disables port fields while the server is actually running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
          return jsonRes({
            server: { status: 'running', display_name: 'Test', tags: [] },
            settings: SETTINGS,
          });
        }
        if (url === '/api/v1/me') return jsonRes({ squad_permissions: [] });
        if (url === '/api/v1/servers/srv-1/rnsquadjs') {
          return jsonRes({ server_id: 'srv-1', mode: 'legacy', cutover: false, status: null });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    const gamePort = await screen.findByRole('spinbutton', { name: 'Игровой порт' });
    expect(gamePort).toBeDisabled();
  });
});

describe('#652 saveLicense/detachLicense must not wipe unsaved draft edits', () => {
  it('keeps an unsaved max_players edit after attaching a license', async () => {
    const patchBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
          return jsonRes({
            server: { status: 'stopped', display_name: 'Test', tags: [], license: null },
            settings: SETTINGS,
          });
        }
        if (url === '/api/v1/servers/srv-1' && init?.method === 'PATCH') {
          patchBodies.push(JSON.parse(init.body as string));
          return jsonRes({ ok: true });
        }
        if (url === '/api/v1/me') return jsonRes({ squad_permissions: [] });
        if (url === '/api/v1/servers/srv-1/rnsquadjs') {
          return jsonRes({ server_id: 'srv-1', mode: 'legacy', cutover: false, status: null });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
      }),
    );
    const user = userEvent.setup();
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    const maxPlayers = await screen.findByRole('spinbutton', { name: 'Максимум игроков' });
    await user.clear(maxPlayers);
    await user.type(maxPlayers, '90');
    expect(maxPlayers).toHaveValue(90);

    await user.type(screen.getByLabelText('ID лицензии'), 'lic-1');
    await user.type(screen.getByLabelText('Ключ лицензии'), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'Привязать' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // The draft edit must survive the license save's reload.
    expect(maxPlayers).toHaveValue(90);
  });
});

describe('#653 initial-load failure must show an error, not a permanent skeleton', () => {
  it('shows an error banner with retry when the initial GET fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response('', { status: 403 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Не удалось загрузить настройки сервера')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});

describe('#654 TagInput save failure must surface an error and roll back', () => {
  it('reverts the tag list and shows an error when the PATCH fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/servers/srv-1' && (!init?.method || init.method === 'GET')) {
          return jsonRes({
            server: { status: 'stopped', display_name: 'Test', tags: ['ru'] },
            settings: SETTINGS,
          });
        }
        if (url === '/api/v1/servers/srv-1' && init?.method === 'PATCH') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
          );
        }
        if (url === '/api/v1/me') return jsonRes({ squad_permissions: [] });
        if (url === '/api/v1/servers/srv-1/rnsquadjs') {
          return jsonRes({ server_id: 'srv-1', mode: 'legacy', cutover: false, status: null });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
      }),
    );
    const user = userEvent.setup();
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('ru')).toBeInTheDocument();
    const input = screen.getByLabelText('Теги');
    await user.type(input, 'eu{Enter}');

    await waitFor(() => expect(screen.getByText(/Не удалось сохранить теги/)).toBeInTheDocument());
    expect(screen.queryByText('eu')).not.toBeInTheDocument();
    expect(screen.getByText('ru')).toBeInTheDocument();
  });
});
