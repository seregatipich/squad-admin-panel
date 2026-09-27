// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ArchivePage from './page';

const ROW = {
  id: 'arc-1',
  display_name: 'EU Main',
  slug: 'eu-main',
  deleted_at: '2026-07-01T00:00:00.000Z',
  deleted_by_steam_id64: '76561198000000000',
  deletion_backup_marker_id: 'mark-1',
};

function mockArchiveFetch({
  permissions = ['server:view'],
  items = [ROW],
}: {
  permissions?: string[];
  items?: Array<typeof ROW>;
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/me') {
        return Promise.resolve(new Response(JSON.stringify({ permissions }), { status: 200 }));
      }
      if (url === '/api/v1/servers/archive') {
        return Promise.resolve(
          new Response(JSON.stringify({ items, total: items.length }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

async function renderPage() {
  await act(async () => {
    render(<ArchivePage />);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArchivePage', () => {
  it('is a valid React component', () => {
    expect(ArchivePage).toBeDefined();
    expect(typeof ArchivePage).toBe('function');
  });

  it('называет колонки по-русски и держит один заголовок первого уровня', async () => {
    mockArchiveFetch();
    await renderPage();

    expect(await screen.findByRole('columnheader', { name: 'Идентификатор' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Slug' })).not.toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Архив серверов');
  });

  it('«Восстановить» — ссылка, доступная без наведения мышью', async () => {
    mockArchiveFetch();
    await renderPage();

    // Ни одного события мыши до этого места: действие обязано быть в дереве
    // доступности сразу, иначе с клавиатуры до него не добраться.
    const restore = await screen.findByRole('link', { name: 'Восстановить' });
    expect(restore).toHaveAttribute('href', '/servers/archive/arc-1/restore');
    expect(restore).toBeVisible();
  });

  it('пустой архив объясняется, а не показывается пустой таблицей', async () => {
    mockArchiveFetch({ items: [] });
    await renderPage();

    const title = await screen.findByText('Архив пуст');
    expect(title.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('без права server:view показывается полоса отказа, а не таблица', async () => {
    mockArchiveFetch({ permissions: [] });
    await renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Доступ запрещён');
    expect(banner).toHaveTextContent('server:view');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
