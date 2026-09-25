// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ replace, push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/external-bans'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

import { ExternalBansBrowser } from './ExternalBansBrowser';

const BAN = {
  id: 'ban-1',
  source_id: 'src-1',
  source_name: 'Источник',
  trust_level: 'trusted',
  discord_url: null,
  nickname: 'Читер',
  reason: 'Чит',
  admin_name: 'Админ',
  issued_at: new Date('2026-01-02T03:04:05Z').toISOString(),
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

function stubFetch(rows: unknown[], total = rows.length, ok = true) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/v1/ban-sources')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (!ok) return Promise.resolve(new Response('', { status: 500 }));
    return Promise.resolve(
      new Response(JSON.stringify({ rows, total, limit: 25, offset: 0 }), { status: 200 }),
    );
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  mockSearchParams = new URLSearchParams();
});

describe('ExternalBansBrowser', () => {
  it('renders one row per identity with a link to the player card', async () => {
    vi.stubGlobal('fetch', stubFetch([ROW]));
    render(<ExternalBansBrowser />);

    expect(await screen.findByRole('link', { name: 'Читер' })).toHaveAttribute(
      'href',
      '/all-players/player-1',
    );
  });

  it('expands the bans of a row and announces the expanded state', async () => {
    vi.stubGlobal('fetch', stubFetch([ROW]));
    render(<ExternalBansBrowser />);

    const toggle = await screen.findByRole('button', { name: 'Показать (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(await screen.findByText('Источник')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скрыть' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('tells an empty registry apart from an empty filter result', async () => {
    mockSearchParams = new URLSearchParams('q=никого');
    vi.stubGlobal('fetch', stubFetch([], 0));
    render(<ExternalBansBrowser />);

    const empty = await screen.findByText('Ничего не нашлось');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'filtered');
  });

  it('resets the filters back to a bare URL', async () => {
    mockSearchParams = new URLSearchParams('q=никого');
    vi.stubGlobal('fetch', stubFetch([], 0));
    render(<ExternalBansBrowser />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сбросить фильтр' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/external-bans'));
  });

  it('offers a retry when the registry request fails', async () => {
    vi.stubGlobal('fetch', stubFetch([], 0, false));
    render(<ExternalBansBrowser />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить реестр');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});
