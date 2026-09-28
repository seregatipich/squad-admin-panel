// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replaceMock = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/combat-log'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { CombatLog } from './CombatLog';
import type { CombatListResponse } from './helpers';

function historyRow(id: number) {
  return {
    id,
    eventType: 'death',
    serverId: 'srv-1',
    matchId: null,
    weapon: 'BP_AK74',
    damage: null,
    attackerKit: null,
    isTeamkill: false,
    occurredAt: '2026-09-25T10:00:00.000Z',
    attacker: null,
    victim: null,
  };
}

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/combat-events')) {
      const body: CombatListResponse = {
        rows: Array.from({ length: 300 }, (_, i) => historyRow(300 - i)),
        nextCursor: 'cursor-after-300',
        approxTotal: 1000,
      };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

describe('CombatLog — COMBAT-529 live cap does not create a pagination gap', () => {
  it('keeps every loaded history row when a live event arrives after 300 rows are loaded', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<CombatLog />);

    // Wait for the 300-row history page to load.
    await screen.findByText(/1\s*000/);

    fireEvent.click(screen.getByLabelText('Живая лента'));

    act(() => {
      liveHandlers.get('combat.event')?.({
        type: 'combat.event',
        data: {
          server_id: 'srv-1',
          match_id: null,
          kind: 'combat_death',
          attacker_player_id: null,
          victim_player_id: null,
          weapon: 'BP_M4',
          damage: null,
          is_teamkill: false,
          is_suicide: false,
          occurred_at: '2026-09-25T10:05:00.000Z',
        },
      });
    });

    // All 300 history rows must still be present: the live-row cap must never
    // trim rows the loaded page's nextCursor still expects to find.
    const rows = screen.getAllByRole('row');
    // header row + 300 history rows + 1 live row
    expect(rows.length).toBe(302);
  });
});
