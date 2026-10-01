// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ replace, push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/external-bans'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

import ExternalBansPage from './page';

const BAN = {
  id: 'ban-1',
  source_id: 'src-1',
  source_name: 'Источник Альфа',
  trust_level: 'trusted',
  discord_url: null,
  nickname: 'Читер',
  reason: 'Использование аимбота',
  admin_name: 'Админ Боб',
  issued_at: '2026-01-02T03:04:05.000Z',
  expires_at: null,
  revoked_at: null,
  is_active: true,
  is_permanent: true,
};

const ROW = {
  steam_id64: '76561198000000000',
  eos_id: null,
  player_id: 'player-1',
  panel_nickname: 'Читер',
  bans: [BAN],
  active_source_count: 1,
};

function stubFetch(opts: { rows?: unknown[]; registryStatus?: number } = {}): string[] {
  const rows = opts.rows ?? [ROW];
  const registryUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/ban-sources/options')) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      registryUrls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ rows, total: rows.length, limit: 25, offset: 0 }), {
          status: opts.registryStatus ?? 200,
        }),
      );
    }),
  );
  return registryUrls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  mockSearchParams = new URLSearchParams();
});

describe('ExternalBansPage', () => {
  it('shows the loading skeleton until the registry arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<ExternalBansPage />);

    expect(await screen.findByText('Загрузка реестра внешних банов')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Внешние баны' })).toBeInTheDocument();
  });

  it('lists an identity with its SteamID64 and the number of sources banning it', async () => {
    const urls = stubFetch();
    render(<ExternalBansPage />);

    expect(await screen.findByRole('link', { name: 'Читер' })).toHaveAttribute(
      'href',
      '/all-players/player-1',
    );
    expect(screen.getByText('76561198000000000')).toBeInTheDocument();
    expect(screen.getByText('Активен в 1')).toBeInTheDocument();
    expect(urls[0]).toMatch(/^\/api\/v1\/external-bans\?/);
  });

  it('shows the empty state for a registry without bans', async () => {
    stubFetch({ rows: [] });
    render(<ExternalBansPage />);

    expect(await screen.findByText('Реестр пуст')).toBeInTheDocument();
  });

  it('shows an error banner with a retry when the registry request fails', async () => {
    stubFetch({ registryStatus: 500 });
    render(<ExternalBansPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить реестр');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('reveals the ban details of an identity on demand', async () => {
    stubFetch();
    render(<ExternalBansPage />);

    expect(screen.queryByText('Использование аимбота')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Показать (1)' }));

    expect(screen.getByText('Использование аимбота')).toBeInTheDocument();
    expect(screen.getByText('Источник Альфа')).toBeInTheDocument();
    expect(screen.getByText('Админ: Админ Боб')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скрыть' })).toBeInTheDocument();
  });

  it('puts a submitted search into the URL', async () => {
    stubFetch();
    render(<ExternalBansPage />);

    await userEvent.type(await screen.findByLabelText('Поиск по реестру'), 'аимбот{Enter}');

    expect(replace).toHaveBeenCalledWith('/external-bans?q=%D0%B0%D0%B8%D0%BC%D0%B1%D0%BE%D1%82');
  });

  it('asks the API for the search from the URL', async () => {
    mockSearchParams = new URLSearchParams('q=аимбот&permanent_only=true');
    const urls = stubFetch({ rows: [] });
    render(<ExternalBansPage />);

    expect(await screen.findByText('Ничего не нашлось')).toBeInTheDocument();
    const query = new URLSearchParams(urls[0]?.split('?')[1]);
    expect(query.get('q')).toBe('аимбот');
    expect(query.get('permanent_only')).toBe('true');
  });
});
