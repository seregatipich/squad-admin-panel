// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SteamFriendCheck } from './SteamFriendCheck';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCheck(response: {
  in_friend: boolean | null;
  reason: string | null;
  cached: boolean;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
  );
  render(<SteamFriendCheck playerId="player-a" otherPlayerId="player-b" />);
  fireEvent.click(screen.getByRole('button', { name: 'Проверить друзей' }));
}

describe('SteamFriendCheck', () => {
  it('shows the configured-state explanation when Steam API is absent', async () => {
    renderCheck({ in_friend: null, reason: 'api_key_missing', cached: false });
    expect(
      await screen.findByText('Steam: Недоступно: Steam API не настроен — добавьте API key'),
    ).toBeInTheDocument();
  });

  it('shows a positive friend result', async () => {
    renderCheck({ in_friend: true, reason: null, cached: false });
    expect(await screen.findByText('Steam: В друзьях')).toBeInTheDocument();
  });

  it('explains that a private profile cannot be checked', async () => {
    renderCheck({ in_friend: null, reason: 'private_profile', cached: false });
    expect(await screen.findByText('Steam: Профиль скрыт')).toBeInTheDocument();
  });

  it('shows a negative cached result', async () => {
    renderCheck({ in_friend: false, reason: null, cached: true });
    const result = await screen.findByText('Steam: Не найдено в друзьях');
    expect(result).toHaveAttribute('title', 'Кэш 24 ч');
  });

  it('explains when the other player has no Steam ID', async () => {
    renderCheck({ in_friend: null, reason: 'no_steam_id', cached: false });
    expect(await screen.findByText('Steam: Нет Steam ID')).toBeInTheDocument();
  });

  it('falls back to a generic unavailable message for an unknown result', async () => {
    renderCheck({ in_friend: null, reason: null, cached: false });
    expect(await screen.findByText('Steam: Проверка недоступна')).toBeInTheDocument();
  });

  it('shows an API error when the check request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'down' }), { status: 503 })),
    );
    render(<SteamFriendCheck playerId="player-a" otherPlayerId="player-b" />);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить друзей' }));
    expect(await screen.findByText('Ошибка Steam: HTTP 503')).toBeInTheDocument();
  });

  it('notifies the parent when a result is received', async () => {
    const onResult = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ in_friend: true, reason: null, cached: false }), {
          status: 200,
        }),
      ),
    );
    render(<SteamFriendCheck playerId="player-a" otherPlayerId="player-b" onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить друзей' }));
    await screen.findByText('Steam: В друзьях');
    expect(onResult).toHaveBeenCalledWith({ in_friend: true, reason: null, cached: false });
  });
});
