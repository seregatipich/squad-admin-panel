// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MatchListItem } from './helpers';

let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
  usePathname: vi.fn(() => '/matches'),
  useSearchParams: vi.fn(() => currentParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { MatchesBrowser } from './MatchesBrowser';

beforeAll(() => {
  // happy-dom does not implement IntersectionObserver; the infinite-scroll
  // sentinel only needs a no-op stand-in for these tests.
  class FakeIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

function match(overrides: Partial<MatchListItem> = {}): MatchListItem {
  return {
    id: 'match-1',
    server_id: 'srv-1',
    server_name: 'Server One',
    server_slug: 'server-one',
    layer: 'Yehorivka_RAAS_v1',
    map: 'Yehorivka',
    game_mode: 'RAAS',
    team1_faction: 'RGF',
    team2_faction: 'USA',
    team1_tickets: 100,
    team2_tickets: 50,
    winner: 'team1',
    is_seed: false,
    started_at: '2026-07-01T10:00:00.000Z',
    ended_at: '2026-07-01T11:00:00.000Z',
    duration_seconds: 3600,
    end_reason: 'ended',
    ...overrides,
  };
}

function stubFetch(opts: { items?: MatchListItem[]; countOk?: boolean } = {}) {
  const items = opts.items ?? [match()];
  const countOk = opts.countOk ?? true;
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/v1/matches/count')) {
      return countOk
        ? Promise.resolve(new Response(JSON.stringify({ total: 3 }), { status: 200 }))
        : Promise.resolve(new Response('', { status: 500 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/matches')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items, next_cursor: null }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  liveHandlers.clear();
  currentParams = new URLSearchParams();
});

describe('MatchesBrowser — всего counter (#585)', () => {
  it('shows the real total once the count request succeeds', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<MatchesBrowser />);

    await waitFor(() => expect(screen.getByText('всего: 3')).toBeInTheDocument());
  });

  it('shows the loading placeholder, not a misleading 0, when the count request fails', async () => {
    vi.stubGlobal('fetch', stubFetch({ countOk: false }));
    render(<MatchesBrowser />);

    await screen.findByText('Yehorivka_RAAS_v1');
    await waitFor(() => expect(screen.getByText('всего: …')).toBeInTheDocument());
    expect(screen.queryByText('всего: 0')).not.toBeInTheDocument();
  });
});

describe('MatchesBrowser — open match row (#584)', () => {
  it('keeps ticking the open match duration without touching the closed one', async () => {
    const startedAt = '2026-07-01T10:00:00.000Z';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Exactly one hour after `startedAt`, so the live and the fixed duration
    // render identically at first — the open row is then the only one that
    // should move once the clock ticks.
    vi.setSystemTime(new Date('2026-07-01T11:00:00.000Z'));

    const openMatch = match({
      id: 'open-1',
      layer: 'Open_Layer',
      started_at: startedAt,
      ended_at: null,
      duration_seconds: null,
    });
    const closedMatch = match({
      id: 'closed-1',
      layer: 'Closed_Layer',
      started_at: startedAt,
      duration_seconds: 3600,
    });
    vi.stubGlobal('fetch', stubFetch({ items: [openMatch, closedMatch] }));
    render(<MatchesBrowser />);

    await vi.waitFor(() => expect(screen.getByText('Open_Layer')).toBeInTheDocument());
    expect(screen.getByText('Идёт')).toBeInTheDocument();
    expect(screen.getAllByText('1ч 0м')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(65_000);

    // The open row's live duration keeps advancing…
    await vi.waitFor(() => expect(screen.getAllByText('1ч 0м')).toHaveLength(1));
    // …and the one instance left is the closed match's untouched, fixed duration.
    expect(screen.getByText('Closed_Layer').closest('tr')).toHaveTextContent('1ч 0м');

    vi.useRealTimers();
  });
});
