// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stableSearchParams = new URLSearchParams();
const { mockUseSearchParams } = vi.hoisted(() => ({
  mockUseSearchParams: vi.fn(),
}));
mockUseSearchParams.mockReturnValue(stableSearchParams);

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/moderation/teamkills'),
  useSearchParams: mockUseSearchParams,
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
        screen.getByText(
          `Предупреждение · ${formatTeamkillDate('2026-07-12T13:00:00.000Z')}, всего 3`,
        ),
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

  it(
    'keeps the response for the current filter even when an older request resolves last',
    async () => {
      // The first (server=all) request is deliberately the slow one; the
      // second (server=srv-2) fires after a filter change and resolves
      // first. Without request cancellation, the stale "all" response would
      // land last and overwrite the fresh per-server one.
      const allRequest: { resolve: (() => void) | null } = { resolve: null };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (url.includes('serverId=srv-2')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ generated_at: SUMMARY.generated_at, rows: [SUMMARY.rows[1]] }),
              { status: 200 },
            ),
          );
        }
        // A fetch honoring AbortSignal rejects once the caller aborts it,
        // exactly like the real browser fetch the fixed component relies on.
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          allRequest.resolve = () =>
            resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
          signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const { rerender } = render(<TeamkillsBrowser />);
      // The "all" request is now in flight but not yet resolved.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      mockUseSearchParams.mockReturnValue(new URLSearchParams('server=srv-2'));
      rerender(<TeamkillsBrowser />);
      await screen.findAllByText('Charlie TK');

      // Now let the stale "all" response resolve, after the newer one, and
      // give its `res.json()` a moment to actually run.
      allRequest.resolve?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(screen.queryByText('Alpha TK')).not.toBeInTheDocument();
      expect(screen.getByText('Charlie TK')).toBeInTheDocument();

      mockUseSearchParams.mockReturnValue(stableSearchParams);
    },
    TEST_TIMEOUT_MS,
  );
});
