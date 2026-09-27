// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/archive/abc'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ArchiveDetailPage from './page';

const DETAIL = {
  server: {
    id: 'abc',
    display_name: 'EU Main',
    slug: 'eu-main',
    description: null,
    deleted_at: '2026-07-01T00:00:00.000Z',
    deleted_by_steam_id64: '76561198000000000',
    deletion_backup_marker_id: 'mark-1',
    tags: null,
  },
  settings: {
    install_path: '/srv/eu-main',
    game_port: 7787,
    query_port: 27165,
    beacon_port: 15000,
    rcon_port: 21114,
    max_players: 80,
    tickrate: 40,
    multihome: null,
  },
  backups: [
    {
      id: 'b-1',
      filename: 'Server.cfg',
      sha256_hex: 'abcdef0123456789',
      message: 'перед удалением',
      created_at: '2026-06-30T00:00:00.000Z',
      author_steam_id64: null,
      author_label: null,
    },
  ],
};

function mockDetailFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/servers/archive/abc') {
        return Promise.resolve(new Response(JSON.stringify(DETAIL), { status: 200 }));
      }
      if (url.startsWith('/api/v1/servers/archive/abc/configs/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'b-1',
              filename: 'Server.cfg',
              content: 'ServerName=EU Main',
              sha256_hex: 'abcdef0123456789',
              created_at: '2026-06-30T00:00:00.000Z',
              message: null,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense>
        <ArchiveDetailPage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArchiveDetailPage', () => {
  it('is a valid React component', () => {
    expect(ArchiveDetailPage).toBeDefined();
    expect(typeof ArchiveDetailPage).toBe('function');
  });

  it('показывает параметры русскими подписями под одним заголовком страницы', async () => {
    mockDetailFetch();
    await renderPage();

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('EU Main');

    expect(screen.getByText('Идентификатор')).toBeInTheDocument();
    expect(screen.queryByText('Slug')).not.toBeInTheDocument();
    expect(screen.getByText('Порт RCON')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Восстановить сервер' })).toHaveAttribute(
      'href',
      '/servers/archive/abc/restore',
    );
  });

  it('файл бэкапа открывается модальным окном с его содержимым', async () => {
    mockDetailFetch();
    await renderPage();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Server.cfg' }));
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ServerName=EU Main');
    expect(dialog).toHaveTextContent('SHA-256: abcdef012345');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
