// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@/lib/live-bus';

const replace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace })),
  usePathname: vi.fn(() => '/combat-log'),
  useSearchParams: vi.fn(() => currentSearchParams),
}));

type LiveHandler = (event: Extract<LiveEvent, { type: 'combat.event' }>) => void;
let liveHandlers: Partial<Record<string, LiveHandler>> = {};
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: LiveHandler) => {
    liveHandlers[type] = handler;
  },
}));

import { CombatLog } from './CombatLog';
import type { CombatListResponse } from './helpers';

function combatEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'combat.event' as const,
    ts: '2026-07-09T10:00:00.000Z',
    data: {
      server_id: '00000000-0000-0000-0000-000000000001',
      match_id: null,
      kind: 'combat_damage',
      attacker_player_id: 'attacker-1',
      victim_player_id: 'victim-1',
      weapon: 'BP_M4A1',
      damage: 30,
      is_teamkill: false,
      is_suicide: false,
      occurred_at: '2026-07-09T10:05:00.000Z',
      ...overrides,
    },
  } as Extract<LiveEvent, { type: 'combat.event' }>;
}

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

/** A first history page of 300 rows with more pages behind it. */
function mockFetchWithHistory() {
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
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
}

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/combat-events')) {
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [], nextCursor: null, approxTotal: 0 }), {
          status: 200,
        }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
  liveHandlers = {};
  currentSearchParams = new URLSearchParams();
});

describe('CombatLog — live feed ignores non-matching events under a narrow facet (#528)', () => {
  it('drops a non-teamkill live event while the "Тимкиллы" facet is selected', async () => {
    currentSearchParams = new URLSearchParams({ facet: 'teamkills' });
    vi.stubGlobal('fetch', mockFetch());
    render(<CombatLog />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Живая лента' }));

    act(() => {
      liveHandlers['combat.event']?.(combatEvent({ is_teamkill: false, weapon: 'NOT_A_TEAMKILL' }));
    });
    expect(screen.queryAllByText('NOT_A_TEAMKILL')).toHaveLength(0);

    act(() => {
      liveHandlers['combat.event']?.(combatEvent({ is_teamkill: true, weapon: 'IS_A_TEAMKILL' }));
    });
    expect((await screen.findAllByText('IS_A_TEAMKILL')).length).toBeGreaterThan(0);
  });
});

describe('CombatLog — PlayerAutocomplete blur only commits on an actual change (#530)', () => {
  it('does not clear a deep-linked attackerPlayerId when the "Кто" field is blurred without typing', async () => {
    currentSearchParams = new URLSearchParams({
      facet: 'teamkills',
      attackerPlayerId: '019dbac8-0000-0000-0000-000000000001',
    });
    vi.stubGlobal('fetch', mockFetch());
    render(<CombatLog />);

    const field = (await screen.findAllByLabelText('Кто'))[0];
    fireEvent.focus(field);
    fireEvent.blur(field);

    expect(replace).not.toHaveBeenCalled();
  });

  it('does commit (and clears the id) when the operator actually types a new name', async () => {
    currentSearchParams = new URLSearchParams({
      attackerPlayerId: '019dbac8-0000-0000-0000-000000000001',
    });
    vi.stubGlobal('fetch', mockFetch());
    render(<CombatLog />);

    const field = (await screen.findAllByLabelText('Кто'))[0];
    fireEvent.change(field, { target: { value: 'NewName' } });
    fireEvent.blur(field);

    expect(replace).toHaveBeenCalled();
    const lastUrl = String(replace.mock.calls.at(-1)?.[0]);
    expect(lastUrl).toContain('attacker=NewName');
    expect(lastUrl).not.toContain('attackerPlayerId');
  });
});

describe('CombatLog — COMBAT-529 live cap does not create a pagination gap', () => {
  it('keeps every loaded history row when a live event arrives after 300 rows are loaded', async () => {
    vi.stubGlobal('fetch', mockFetchWithHistory());
    render(<CombatLog />);

    // Wait for the 300-row history page to load.
    await screen.findByText(/1\s*000/);

    fireEvent.click(screen.getByLabelText('Живая лента'));

    act(() => {
      liveHandlers['combat.event']?.(
        combatEvent({
          server_id: 'srv-1',
          kind: 'combat_death',
          attacker_player_id: null,
          victim_player_id: null,
          weapon: 'BP_M4',
          damage: null,
          occurred_at: '2026-09-25T10:05:00.000Z',
        }),
      );
    });

    // All 300 history rows must still be present: the live-row cap must never
    // trim rows the loaded page's nextCursor still expects to find.
    const rows = screen.getAllByRole('row');
    // header row + 300 history rows + 1 live row
    expect(rows.length).toBe(302);
    // Renders and re-renders a 300-row table, so the default 5s is too tight under coverage load.
  }, 20_000);
});
