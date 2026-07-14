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
});
