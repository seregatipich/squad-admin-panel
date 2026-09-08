// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.fn(() => '/servers/srv-1');
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

import ServerSectionLayout from './layout';

const SERVER_ID = 'srv-1';

function stubServerFetch(displayName = 'Squad EU #1', runtime = 'container') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ server: { display_name: displayName, runtime } }), {
          status: 200,
        }),
      ),
    ),
  );
}

async function renderLayout() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <ServerSectionLayout params={Promise.resolve({ id: SERVER_ID })}>
          <p>содержимое подраздела</p>
        </ServerSectionLayout>
      </Suspense>,
    );
  });
  return result;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  pathnameMock.mockReturnValue(`/servers/${SERVER_ID}`);
});

describe('ServerSectionLayout', () => {
  it('holds the section width itself, so the header and the page share one left edge', async () => {
    // Пока ширину выбирала подстраница, заголовок и вкладки оставались во всю
    // ширину окна, а содержимое сжималось — раздел разъезжался по левому краю.
    stubServerFetch();
    const { container } = await renderLayout();

    const shell = container.firstElementChild;
    expect(shell).toHaveClass('max-w-6xl');
    expect(shell).toHaveClass('mx-auto');
    expect(shell).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(shell).toContainElement(screen.getByText('содержимое подраздела'));
    expect(shell).toContainElement(screen.getByRole('navigation', { name: 'Разделы сервера' }));
  });

  it('renders the server name as the section heading', async () => {
    stubServerFetch();
    await renderLayout();

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Squad EU #1'),
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('keeps a placeholder heading and still renders the subsection when the name cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(new Response('nope', { status: 500 }))),
    );
    await renderLayout();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Сервер');
    expect(screen.getByText('содержимое подраздела')).toBeInTheDocument();
  });

  it('links to every subsection, including the combat log', async () => {
    stubServerFetch();
    await renderLayout();

    const nav = screen.getByRole('navigation', { name: 'Разделы сервера' });
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.map((link) => link.textContent)).toEqual([
      'Обзор',
      'Конфиги',
      'Ротация',
      'Календарь ротации',
      'Голосование за карту',
      'Планировщик',
      'События',
      'Боевой лог',
      'Мониторинг',
      'Настройки',
    ]);
    expect(screen.getByRole('link', { name: 'Боевой лог' })).toHaveAttribute(
      'href',
      `/servers/${SERVER_ID}/combat-log`,
    );
  });

  it('marks the open subsection with aria-current, and only it', async () => {
    pathnameMock.mockReturnValue(`/servers/${SERVER_ID}/rotation-calendar`);
    stubServerFetch();
    await renderLayout();

    expect(screen.getByRole('link', { name: 'Календарь ротации' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Ротация' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Обзор' })).not.toHaveAttribute('aria-current');
  });

  it('marks the overview tab on the section root', async () => {
    stubServerFetch();
    await renderLayout();

    expect(screen.getByRole('link', { name: 'Обзор' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('ServerSectionLayout — внешний сервер', () => {
  it('прячет файловые и контейнерные подразделы и помечает сервер бейджем', async () => {
    // У внешнего сервера нет конфигов, ротации и контейнера — API отвечает на
    // эти маршруты 409, поэтому вкладок быть не должно.
    stubServerFetch('RAAS/AAS #1', 'external');
    await renderLayout();
    await waitFor(() => expect(screen.getByText('внешний')).toBeInTheDocument());

    const nav = screen.getByRole('navigation', { name: 'Разделы сервера' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toEqual([
      'Обзор',
      'Голосование за карту',
      'Планировщик',
      'События',
      'Боевой лог',
      'Настройки',
    ]);
  });

  it('у контейнерного сервера показывает все подразделы и не вешает бейдж', async () => {
    stubServerFetch('Squad EU #1', 'container');
    await renderLayout();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Squad EU #1'),
    );
    const nav = screen.getByRole('navigation', { name: 'Разделы сервера' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toContain('Конфиги');
    expect(labels).toContain('Мониторинг');
    expect(screen.queryByText('внешний')).not.toBeInTheDocument();
  });
});
