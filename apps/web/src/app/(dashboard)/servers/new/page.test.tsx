// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: pushMock, refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/new'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LogConsole', () => ({ LogConsole: () => null }));

import NewServerPage from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  pushMock.mockClear();
});

describe('NewServerPage', () => {
  it('is a valid React component', () => {
    expect(NewServerPage).toBeDefined();
    expect(typeof NewServerPage).toBe('function');
  });

  it('поля мастера подписаны по-русски и связаны с подписями', () => {
    render(<NewServerPage />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Установка нового Squad-сервера');

    expect(screen.getByLabelText(/^Название/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Идентификатор/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Установить' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('link', { name: 'К списку серверов' })).toHaveAttribute(
      'href',
      '/servers',
    );
  });

  it('идентификатор выводится из названия, пока его не правили руками', () => {
    render(<NewServerPage />);

    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'My Squad' } });
    const slug = screen.getByLabelText(/^Идентификатор/);
    expect(slug).toHaveValue('my-squad');

    // Правка вручную отвязывает идентификатор от названия.
    fireEvent.change(slug, { target: { value: 'eu-main' } });
    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'Other Name' } });
    expect(screen.getByLabelText(/^Идентификатор/)).toHaveValue('eu-main');
  });
});

describe('NewServerPage — подключение существующего сервера', () => {
  function switchToExternal() {
    fireEvent.click(screen.getByRole('tab', { name: 'Подключить существующий' }));
  }

  it('по умолчанию открыт мастер установки, а внешний режим переключается сегментом', () => {
    render(<NewServerPage />);
    expect(screen.getByRole('tablist', { name: 'Способ добавления сервера' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Адрес RCON/)).not.toBeInTheDocument();

    switchToExternal();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Подключение существующего сервера',
    );
    expect(screen.getByLabelText(/^Адрес RCON/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Пароль RCON/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/^Порт запросов/)).toHaveValue(27165);
    expect(screen.getByRole('button', { name: 'Подключить' })).toHaveAttribute('type', 'submit');
    // Портов маяка у внешнего сервера нет — панель его не запускает.
    expect(screen.queryByLabelText(/^Beacon/)).not.toBeInTheDocument();
  });

  it('отправляет POST /api/v1/servers/external и открывает страницу сервера', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'srv-ext', status: 'running', runtime: 'external' }), {
          status: 201,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<NewServerPage />);
    switchToExternal();

    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'RAAS/AAS #1' } });
    fireEvent.change(screen.getByLabelText(/^Адрес RCON/), { target: { value: '203.0.113.10' } });
    fireEvent.change(screen.getByLabelText(/^Пароль RCON/), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/servers/srv-ext'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/servers/external');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      display_name: 'RAAS/AAS #1',
      slug: 'raas-aas-1',
      rcon_host: '203.0.113.10',
      rcon_port: 21114,
      rcon_password: 's3cret',
      query_port: 27165,
      game_port: 7787,
      max_players: 100,
    });
  });

  it('показывает понятную ошибку, когда идентификатор занят', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'slug_in_use', message: 'taken' }), { status: 409 }),
        ),
      ),
    );
    render(<NewServerPage />);
    switchToExternal();
    fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByLabelText(/^Адрес RCON/), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText(/^Пароль RCON/), { target: { value: 'p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    expect(await screen.findByText(/идентификатор уже занят/)).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
