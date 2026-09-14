// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import ServersPage from './page';

function makeServer(overrides: {
  id: string;
  display_name: string;
  tags: string[];
  runtime?: string;
}) {
  return {
    slug: overrides.display_name.toLowerCase().replace(/\s+/g, '-'),
    status: 'running',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    rcon_state: null,
    player_count: null,
    last_poll_at: null,
    seeding: null,
    ...overrides,
  };
}

function mockServersFetch(
  items = [
    makeServer({ id: 'srv-1', display_name: 'EU Main', tags: ['eu'] }),
    makeServer({ id: 'srv-2', display_name: 'NA Main', tags: ['na'] }),
  ],
) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/v1/servers') {
      return Promise.resolve(
        new Response(JSON.stringify({ items, total: items.length }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage() {
  await act(async () => {
    render(<ServersPage />);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServersPage', () => {
  it('is a valid React component', () => {
    expect(ServersPage).toBeDefined();
    expect(typeof ServersPage).toBe('function');
  });

  it('tag filter narrows the server list', async () => {
    mockServersFetch();
    await renderPage();
    // Both servers listed before a tag is picked.
    expect(await screen.findByText('EU Main')).toBeInTheDocument();
    expect(screen.getByText('NA Main')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Фильтр по тегу' }), {
      target: { value: 'eu' },
    });

    expect(screen.getByText('EU Main')).toBeInTheDocument();
    expect(screen.queryByText('NA Main')).not.toBeInTheDocument();

    // Back to «Все теги» restores the full list.
    fireEvent.change(screen.getByRole('combobox', { name: 'Фильтр по тегу' }), {
      target: { value: '' },
    });
    expect(screen.getByText('NA Main')).toBeInTheDocument();
  });

  it('страница называет себя единственным заголовком первого уровня', async () => {
    mockServersFetch();
    await renderPage();

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Серверы');
  });

  it('действия строки доступны по имени, а не только по значку', async () => {
    mockServersFetch();
    await renderPage();
    await screen.findByText('EU Main');

    // Оба сервера в статусе running: «Пуск» недоступен, «Стоп» и «Рестарт» — да,
    // но имя есть у каждой кнопки независимо от доступности.
    expect(screen.getAllByRole('button', { name: 'Пуск' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Стоп' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Рестарт' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Открыть' })).toHaveLength(2);

    // Состояние названо словом, а не только цветом точки.
    expect(screen.getAllByText('работает')).toHaveLength(2);
  });

  it('пустой список предлагает установить первый сервер', async () => {
    mockServersFetch([]);
    await renderPage();

    const title = await screen.findByText('Серверов пока нет');
    expect(title.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
    expect(screen.getAllByRole('link', { name: 'Добавить сервер' }).length).toBeGreaterThan(0);
  });

  it('фильтр без совпадений даёт отдельное пустое состояние и сброс', async () => {
    mockServersFetch();
    await renderPage();
    await screen.findByText('EU Main');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск серверов' }), {
      target: { value: 'нет-такого-сервера' },
    });

    const title = await screen.findByText('Ничего не нашлось');
    expect(title.closest('[data-variant]')).toHaveAttribute('data-variant', 'filtered');

    // Сброс возвращает полный список: и в панели инструментов, и в пустом состоянии
    // это одно и то же действие.
    fireEvent.click(screen.getAllByRole('button', { name: 'Сбросить фильтры' })[0]);
    expect(await screen.findByText('EU Main')).toBeInTheDocument();
  });

  it('ошибка запроса показывается полосой с действием «Повторить»', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Не удалось получить список серверов');
    expect(banner).toHaveTextContent('HTTP 500');
    // Список не загрузился — это не «серверов нет»: приглашение установить
    // первый сервер под полосой ошибки увело бы оператора заводить дубликат.
    expect(screen.queryByText('Серверов пока нет')).not.toBeInTheDocument();

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/servers', expect.anything());
  });
});

describe('ServersPage — внешний сервер', () => {
  it('помечает внешний сервер бейджем и не предлагает ему пуск/стоп', async () => {
    mockServersFetch([
      makeServer({ id: 'srv-ext', display_name: 'RAAS/AAS #1', tags: [], runtime: 'external' }),
      makeServer({ id: 'srv-loc', display_name: 'Local Box', tags: [], runtime: 'container' }),
    ]);
    await renderPage();
    await screen.findByRole('link', { name: 'RAAS/AAS #1' });

    expect(screen.getAllByText('внешний')).toHaveLength(1);
    // Одна строка с кнопками жизненного цикла — контейнерная; у внешней только «Открыть».
    expect(screen.getAllByRole('button', { name: 'Пуск' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Открыть' })).toHaveLength(2);
  });
});
