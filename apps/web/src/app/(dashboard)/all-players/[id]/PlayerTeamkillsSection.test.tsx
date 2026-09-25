// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatTeamkillDate } from '../../moderation/teamkills/helpers';
import { PlayerTeamkillsSection } from './PlayerTeamkillsSection';

const TEST_TIMEOUT_MS = 15_000;

function stubStatsFetch(overrides: Partial<Record<string, unknown>> = {}) {
  const body = {
    stats: {
      player_id: 'player-alpha',
      current_name: 'Alpha TK',
      steam_id64: '76561198200000001',
      eos_id: null,
      tk_total: 11,
      tk_7d: 9,
      tk_30d: 10,
      victim_of_tk_total: 2,
      last_tk_at: '2026-07-12T14:00:00.000Z',
      moderation_total: 0,
      last_moderation_at: null,
      last_moderation_type: null,
      ...overrides,
    },
    recent: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlayerTeamkillsSection moderation metric', () => {
  it(
    'shows a muted zero and no subline when the player has no moderation history',
    async () => {
      stubStatsFetch();
      render(<PlayerTeamkillsSection playerId="player-alpha" />);

      await screen.findByText('Модерация');
      expect(screen.queryByText(/Последнее:/)).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the moderation count and last-action subline when history exists',
    async () => {
      stubStatsFetch({
        moderation_total: 3,
        last_moderation_at: '2026-07-12T13:00:00.000Z',
        last_moderation_type: 'warn',
      });
      render(<PlayerTeamkillsSection playerId="player-alpha" />);

      await screen.findByText('Модерация');
      expect(
        screen.getByText(`Последнее: warn · ${formatTeamkillDate('2026-07-12T13:00:00.000Z')}`),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
