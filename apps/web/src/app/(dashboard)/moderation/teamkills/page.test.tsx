// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stableSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/moderation/teamkills'),
  useSearchParams: vi.fn(() => stableSearchParams),
}));

import { formatTeamkillDate } from './helpers';
import TeamkillsPage from './page';
import { TeamkillsBrowser } from './TeamkillsBrowser';

const TEST_TIMEOUT_MS = 15_000;

const SUMMARY = {
  generated_at: '2026-07-12T15:00:00.000Z',
  rows: [
    {
      player_id: 'player-alpha',
      current_name: 'Alpha TK',
      steam_id64: '76561198200000001',
      eos_id: null,
      tk_total: 11,
      tk_7d: 9,
      tk_30d: 10,
      victim_of_tk_total: 2,
      last_tk_at: '2026-07-12T14:00:00.000Z',
      moderation_total: 3,
      last_moderation_at: '2026-07-12T13:00:00.000Z',
      last_moderation_type: 'warn',
    },
    {
      player_id: 'player-charlie',
      current_name: 'Charlie TK',
      steam_id64: null,
      eos_id: 'eos-charlie',
      tk_total: 3,
      tk_7d: 2,
      tk_30d: 3,
      victim_of_tk_total: 0,
      last_tk_at: '2026-07-12T10:00:00.000Z',
      moderation_total: 0,
      last_moderation_at: null,
      last_moderation_type: null,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/v1/servers')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TeamkillsPage', () => {
  it('is a valid React component', () => {
    expect(TeamkillsPage).toBeDefined();
    expect(typeof TeamkillsPage).toBe('function');
  });
});

describe('TeamkillsBrowser moderation column', () => {
  it(
    'renders the Модерация header and a formatted moderation summary per row',
    async () => {
      render(<TeamkillsBrowser />);

      await screen.findAllByText('Alpha TK');
      expect(screen.getByText('Модерация')).toBeInTheDocument();
      expect(
        screen.getByText(`warn · ${formatTeamkillDate('2026-07-12T13:00:00.000Z')}, всего 3`),
      ).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders an em dash for offenders with no moderation history',
    async () => {
      render(<TeamkillsBrowser />);

      await screen.findAllByText('Charlie TK');
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
