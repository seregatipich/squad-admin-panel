// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'srv-1' })) };
});

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
};

function mockFetch(overrides: { putSettings?: (body: unknown) => Response } = {}) {
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
    if (url === '/api/v1/servers/srv-1/settings' && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      if (overrides.putSettings) return Promise.resolve(overrides.putSettings(body));
      return Promise.resolve(
        new Response(JSON.stringify({ ...SETTINGS, ...body }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage chat-commands section', () => {
  it('renders the toggle and rules-text field prefilled from settings', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Чат-команды')).toBeInTheDocument();
    const toggle = screen.getByRole('checkbox', { name: /Включить игровые чат-команды/ });
    expect(toggle).toBeChecked();
    expect(screen.getByDisplayValue('Не читерить.')).toBeInTheDocument();
  });

  it('sends chat_commands_enabled + rules_text in the settings PUT on save', async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch({
        putSettings: (body) => {
          putBodies.push(body);
          return new Response(JSON.stringify({ ...SETTINGS, ...(body as object) }), {
            status: 200,
          });
        },
      }),
    );
    const user = userEvent.setup();
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    const toggle = await screen.findByRole('checkbox', { name: /Включить игровые чат-команды/ });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ chat_commands_enabled: false });
  });
});
