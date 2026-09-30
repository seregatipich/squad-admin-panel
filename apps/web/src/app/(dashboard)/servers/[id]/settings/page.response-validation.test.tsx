// @vitest-environment happy-dom
// Regression tests for issue #86 finding 656: API responses are validated, not cast.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'srv-1' })) };
});
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
  seed_live_at: 60,
  seed_hysteresis: 5,
  chat_commands_enabled: true,
  rules_text: null,
  archive_logs_to_backup: false,
};

function jsonRes(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** Serves `detail` for GET /servers/srv-1 and benign answers for the side requests. */
function stubFetch(detail: () => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/servers/srv-1') return jsonRes(detail());
      if (url === '/api/v1/me') return jsonRes({ squad_permissions: [] });
      return jsonRes({ error: 'not_found' }, 404);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#656 GET /servers/:id response validation', () => {
  it('shows a load error instead of a skeleton forever when the server has no settings row', async () => {
    stubFetch(() => ({ server: { status: 'stopped', display_name: 'Test' }, settings: null }));
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Не удалось загрузить настройки сервера')).toBeTruthy();
    expect(screen.getByText('У сервера нет сохранённых настроек')).toBeTruthy();
  });

  it('reports a drifted response as a readable error, not a TypeError', async () => {
    stubFetch(() => ({ settings: SETTINGS }));
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    expect(await screen.findByText('Неожиданный ответ сервера: сервер')).toBeTruthy();
  });

  it('clears the load error after a successful retry', async () => {
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? { settings: SETTINGS }
        : { server: { status: 'stopped', display_name: 'Test' }, settings: SETTINGS };
    });
    render(<SettingsPage params={Promise.resolve({ id: 'srv-1' })} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('spinbutton', { name: 'Максимум игроков' })).toBeTruthy();
    expect(screen.queryByText('Неожиданный ответ сервера: сервер')).toBeNull();
  });
});
