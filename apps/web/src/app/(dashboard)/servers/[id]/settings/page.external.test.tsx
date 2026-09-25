// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'srv-ext' })) };
});
vi.mock('@/components/TagInput', () => ({ TagInput: () => null }));
vi.mock('next/navigation', () => ({ useRouter: vi.fn(() => ({ push: vi.fn() })) }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import SettingsPage from './page';

const settings = {
  server_id: 'srv-ext',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 100,
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

function detail(runtime: 'external' | 'container') {
  return {
    server: {
      status: 'running',
      display_name: 'RAAS/AAS #1',
      tags: [],
      runtime,
      license: null,
    },
    settings,
    container: null,
    host: null,
    connection: runtime === 'external' ? { rcon_host: '203.0.113.10', rcon_port: 21114 } : null,
  };
}

function stubFetch(runtime: 'external' | 'container') {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/v1/servers/srv-ext' && !init?.method) {
        return new Response(JSON.stringify(detail(runtime)), { status: 200 });
      }
      if (url === '/api/v1/me') {
        return new Response(JSON.stringify({ squad_permissions: [] }), { status: 200 });
      }
      if (url === '/api/v1/servers/srv-ext/rnsquadjs') {
        return new Response(JSON.stringify({ error: 'external_server' }), { status: 409 });
      }
      if (url === '/api/v1/servers/srv-ext/log-source' && !init?.method) {
        return new Response(JSON.stringify({ configured: false, status: null }), { status: 200 });
      }
      if (url === '/api/v1/servers/srv-ext/log-source' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            configured: true,
            kind: 'ssh',
            ssh_host: body.ssh_host,
            ssh_port: body.ssh_port,
            ssh_user: body.ssh_user,
            log_path: body.log_path,
            enabled: body.enabled,
            public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAA squad-admin-panel@tk104',
            host_key_fingerprint: null,
            key_version: 1,
            updated_at: '2026-09-07T10:00:00.000Z',
            status: null,
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/servers/srv-ext/external-connection' && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            id: 'srv-ext',
            rcon_host: '198.51.100.7',
            rcon_port: 21114,
            query_port: 27165,
            game_port: 7787,
            max_players: 100,
            password_updated: false,
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage — внешний сервер', () => {
  it('показывает секцию RCON-подключения вместо портов, ресурсов, архива логов и лицензии', async () => {
    stubFetch('external');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });
    await screen.findByText('RCON-подключение');

    expect(screen.getByLabelText('Адрес RCON')).toHaveValue('203.0.113.10');
    expect(screen.getByLabelText('Пароль RCON')).toHaveAttribute('type', 'password');
    expect(screen.queryByText('Сеть')).not.toBeInTheDocument();
    expect(screen.queryByText('Ресурсы')).not.toBeInTheDocument();
    expect(screen.queryByText('Архив логов')).not.toBeInTheDocument();
    expect(screen.queryByText('Лицензия')).not.toBeInTheDocument();
    // Настройки игры (максимум игроков, чат-команды) остаются — они идут через RCON/БД.
    expect(screen.getByLabelText('Максимум игроков')).toBeInTheDocument();
  });

  it('держит управление сервером (удаление, старт/стоп) в настройках', async () => {
    stubFetch('container');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });

    expect(await screen.findByText('Управление')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Стоп' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Опасная зона/ })).toBeInTheDocument();
  });

  it('сохраняет подключение через PUT /external-connection и не шлёт пустой пароль', async () => {
    const calls = stubFetch('external');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });
    await screen.findByText('RCON-подключение');

    const save = screen.getByRole('button', { name: 'Сохранить подключение' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Адрес RCON'), { target: { value: '198.51.100.7' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(
        calls.find((c) => c.url === '/api/v1/servers/srv-ext/external-connection'),
      ).toBeDefined(),
    );
    const put = calls.find((c) => c.url === '/api/v1/servers/srv-ext/external-connection');
    expect(put?.init?.method).toBe('PUT');
    expect(JSON.parse(String(put?.init?.body))).toEqual({ rcon_host: '198.51.100.7' });
    expect(await screen.findByText('Подключение сохранено')).toBeInTheDocument();
  });

  it('у контейнерного сервера секция подключения не появляется', async () => {
    stubFetch('container');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });
    await screen.findByText('Сеть');
    expect(screen.queryByText('RCON-подключение')).not.toBeInTheDocument();
    expect(screen.getByText('Ресурсы')).toBeInTheDocument();
  });
});

describe('SettingsPage — источник логов внешнего сервера', () => {
  it('создаёт SSH-источник, отправляет PUT /log-source и показывает публичный ключ', async () => {
    const calls = stubFetch('external');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });
    await screen.findByText('Источник логов (SSH)');
    expect(screen.queryByLabelText('Публичный ключ панели')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Хост SSH'), { target: { value: '80.242.59.123' } });
    fireEvent.change(screen.getByLabelText(/^Путь к SquadGame.log/), {
      target: { value: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать источник и ключ' }));

    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.url === '/api/v1/servers/srv-ext/log-source' && c.init?.method === 'PUT',
        ),
      ).toBeDefined(),
    );
    const put = calls.find(
      (c) => c.url === '/api/v1/servers/srv-ext/log-source' && c.init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      ssh_host: '80.242.59.123',
      ssh_port: 22,
      ssh_user: 'squad',
      log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
      enabled: true,
      regenerate_key: false,
    });
    expect(await screen.findByLabelText('Публичный ключ панели')).toHaveValue(
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAA squad-admin-panel@tk104',
    );
    expect(screen.getByRole('button', { name: 'Перевыпустить ключ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить источник' })).toBeInTheDocument();
  });

  it('у контейнерного сервера секция источника логов не запрашивается', async () => {
    const calls = stubFetch('container');
    await act(async () => {
      render(<SettingsPage params={Promise.resolve({ id: 'srv-ext' })} />);
    });
    await screen.findByText('Сеть');
    expect(screen.queryByText('Источник логов (SSH)')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/log-source'))).toBe(false);
  });
});
