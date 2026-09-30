// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClanStatsPanel from './ClanStatsPanel';

const MEMBER_COUNT = 10;

function statsBody(overrides: Record<string, unknown> = {}) {
  return {
    clan_id: 'clan-1',
    from: '2026-01-01',
    to: '2026-01-30',
    roster_size: MEMBER_COUNT,
    chart: [{ day: '2026-01-01', online_seconds: 60, boost_seconds: 0 }],
    totals: { online_seconds: 60, boost_seconds: 0, primary_server: null },
    primetime: {
      total_seconds: 0,
      histogram: Array.from({ length: 24 }, () => 0),
      rolling_average: [],
      range: null,
    },
    combat: {
      kills: 10,
      deaths: 5,
      revives: 1,
      kd: 2,
      top: Array.from({ length: MEMBER_COUNT }, (_, index) => ({
        player_id: `player-${index}`,
        canonical_name: `Игрок ${index}`,
        kills: 10 - index,
        deaths: 1,
        revives: 0,
        kd: 1,
      })),
    },
    ...overrides,
  };
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClanStatsPanel', () => {
  it('shows every combat leader the API returns, not a truncated half', async () => {
    stubFetch(statsBody());
    render(<ClanStatsPanel clanId="clan-1" />);
    await waitFor(() => expect(screen.getByText('Игрок 0')).toBeInTheDocument());
    expect(screen.getByText(`Игрок ${MEMBER_COUNT - 1}`)).toBeInTheDocument();
  });

  it('turns a malformed response into an error banner instead of crashing', async () => {
    stubFetch(statsBody({ combat: null }));
    render(<ClanStatsPanel clanId="clan-1" />);
    await waitFor(() => expect(screen.getByText(/Некорректный ответ сервера/)).toBeInTheDocument());
  });
});
