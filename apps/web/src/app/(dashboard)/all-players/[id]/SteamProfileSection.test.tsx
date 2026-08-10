// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SteamProfileSection, type SteamSnapshot } from './SteamProfileSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FULL: SteamSnapshot = {
  avatar_url: 'https://avatars.steamstatic.com/full.jpg',
  persona_name: 'Стим Ник',
  profile_visibility: 3,
  steam_account_created_at: '2011-03-13T07:06:40.000Z',
  vac_banned: true,
  vac_ban_count: 2,
  game_ban_count: 1,
  days_since_last_ban: 512,
  owns_squad: true,
  steam_playtime_minutes: 600,
  steam_checked_at: '2026-07-27T10:00:00.000Z',
};

function renderSection(
  snapshot: SteamSnapshot,
  steamId64: string | null = '76561197999981002',
): void {
  render(<SteamProfileSection playerId="player-a" steamId64={steamId64} snapshot={snapshot} />);
}

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status, statusText: 'x' }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SteamProfileSection', () => {
  it('renders a positive VAC status with the ban counters', () => {
    renderSection(FULL);
    expect(screen.getByTestId('steam-vac')).toHaveTextContent('Да');
    expect(screen.getByTestId('steam-game-bans')).toHaveTextContent('1');
    expect(screen.getByTestId('steam-days-since-ban')).toHaveTextContent('512');
  });

  it('renders a clean account as not VAC banned with no last-ban distance', () => {
    renderSection({ ...FULL, vac_banned: false, vac_ban_count: 0, days_since_last_ban: null });
    expect(screen.getByTestId('steam-vac')).toHaveTextContent('Нет');
    expect(screen.getByTestId('steam-days-since-ban')).toHaveTextContent('—');
  });

  it('renders every Steam row as a dash for a player without a SteamID64', () => {
    renderSection({}, null);
    expect(screen.getByTestId('steam-vac')).toHaveTextContent('—');
    expect(screen.getByTestId('steam-owns-squad')).toHaveTextContent('—');
    expect(screen.queryByRole('button', { name: 'Обновить из Steam' })).not.toBeInTheDocument();
  });

  it('says the player owns Squad and shows the rounded playtime in hours', () => {
    renderSection(FULL);
    expect(screen.getByTestId('steam-owns-squad')).toHaveTextContent('Да');
    expect(screen.getByTestId('steam-playtime')).toHaveTextContent('10 ч');
  });

  it('says the player does not own Squad', () => {
    renderSection({ ...FULL, owns_squad: false, steam_playtime_minutes: null });
    expect(screen.getByTestId('steam-owns-squad')).toHaveTextContent('Нет');
    expect(screen.getByTestId('steam-playtime')).toHaveTextContent('—');
  });

  it('says ownership is hidden when Steam did not disclose the game list', () => {
    renderSection({ ...FULL, owns_squad: null });
    expect(screen.getByTestId('steam-owns-squad')).toHaveTextContent('Скрыто');
  });

  it('says the player was never checked when there is no check timestamp', () => {
    renderSection({});
    expect(screen.getByTestId('steam-checked-at')).toHaveTextContent('не проверялся');
  });

  it('refreshes from Steam and shows the new snapshot without a page reload', async () => {
    const fetchMock = stubFetch(200, {
      avatar_url: 'https://avatars.steamstatic.com/new.jpg',
      persona_name: 'Новый Ник',
      profile_visibility: 3,
      steam_account_created_at: null,
      vac_banned: false,
      vac_ban_count: 0,
      game_ban_count: 0,
      days_since_last_ban: null,
      owns_squad: false,
      steam_playtime_minutes: null,
      steam_checked_at: '2026-07-27T12:00:00.000Z',
    });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));

    expect(await screen.findByText('Нет', { selector: '[data-testid="steam-vac"]' })).toBeVisible();
    expect(screen.getByTestId('steam-owns-squad')).toHaveTextContent('Нет');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/players/player-a/steam-refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('reports a missing Steam API key from a 503', async () => {
    stubFetch(503, { error: 'steam_api_key_missing' });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('Steam API не настроен')).toBeInTheDocument();
  });

  it('reports a Steam outage from a 502', async () => {
    stubFetch(502, { error: 'steam_api_error' });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('Steam недоступен, попробуйте позже')).toBeInTheDocument();
  });

  it('reports a missing SteamID64 from a 409', async () => {
    stubFetch(409, { error: 'no_steam_id' });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('У игрока нет SteamID')).toBeInTheDocument();
  });

  it('reports insufficient permissions from a 403', async () => {
    stubFetch(403, { error: 'forbidden' });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('Недостаточно прав')).toBeInTheDocument();
  });

  it('falls back to the HTTP status for an unmapped failure', async () => {
    stubFetch(418, { error: 'teapot' });
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('Ошибка HTTP 418')).toBeInTheDocument();
  });

  it('surfaces a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderSection(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Обновить из Steam' }));
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});
