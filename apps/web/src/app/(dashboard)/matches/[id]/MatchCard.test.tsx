// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchDetail } from '../helpers';
import { MatchCard } from './MatchCard';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const TEST_TIMEOUT_MS = 15_000;

function matchDetail(overrides: Partial<MatchDetail> = {}): MatchDetail {
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
    team1_tickets: 120,
    team2_tickets: 80,
    winner: 'team1',
    is_seed: false,
    started_at: '2026-05-21T10:00:00.000Z',
    ended_at: '2026-05-21T11:00:00.000Z',
    duration_seconds: 3600,
    end_reason: 'ended',
    roster: [
      {
        player_id: 'player-full-time',
        nickname: 'FullTimer',
        team: 1,
        squad_name: 'Alpha',
        play_seconds: 3600,
        left_at: null,
        left_early: false,
        kills: 5,
        deaths: 1,
        teamkills: 0,
        wounds: 2,
        revives: 1,
      },
      {
        player_id: 'player-left-early',
        nickname: 'EarlyLeaver',
        team: 1,
        squad_name: 'Alpha',
        play_seconds: 900,
        left_at: '2026-05-21T10:15:00.000Z',
        left_early: true,
        kills: null,
        deaths: null,
        teamkills: null,
        wounds: null,
        revives: null,
      },
    ],
    teams: {
      team1: {
        players: 2,
        play_seconds: 4500,
        kills: 5,
        deaths: 1,
        teamkills: 0,
        wounds: 2,
        revives: 1,
      },
      team2: {
        players: 0,
        play_seconds: 0,
        kills: null,
        deaths: null,
        teamkills: null,
        wounds: null,
        revives: null,
      },
    },
    previous_match: null,
    next_match: null,
    combat_events: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(matchDetail()), { status: 200 }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MatchCard', () => {
  it('is a valid React component', () => {
    expect(MatchCard).toBeDefined();
    expect(typeof MatchCard).toBe('function');
  });

  it(
    'dims the roster row of a player who left before the match ended, but keeps the full-time row normal',
    async () => {
      render(<MatchCard matchId="match-1" />);
      const earlyRow = await screen.findByText('EarlyLeaver');
      const earlyTr = earlyRow.closest('tr');
      expect(earlyTr).toHaveClass('opacity-50');
      expect(earlyTr).toHaveAttribute('title', 'Покинул матч до конца');

      const fullTimeRow = screen.getByText('FullTimer');
      const fullTimeTr = fullTimeRow.closest('tr');
      expect(fullTimeTr).not.toHaveClass('opacity-50');
      expect(fullTimeTr).not.toHaveAttribute('title');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the dimmed player link clickable to their player card',
    async () => {
      render(<MatchCard matchId="match-1" />);
      const earlyLink = await screen.findByText('EarlyLeaver');
      expect(earlyLink.closest('a')).toHaveAttribute('href', '/all-players/player-left-early');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders null combat stats as "—" for the dimmed row instead of substituting 0',
    async () => {
      render(<MatchCard matchId="match-1" />);
      await screen.findByText('EarlyLeaver');
      const earlyTr = screen.getByText('EarlyLeaver').closest('tr');
      // Columns: nickname, squad, time, K/D, TK, wounds, revives.
      const cells = earlyTr?.querySelectorAll('td') ?? [];
      const [, , , kd, tk, wounds, revives] = Array.from(cells).map((cell) => cell.textContent);
      expect([kd, tk, wounds, revives]).toEqual(['—', '—', '—', '—']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the no-access state when combat_events is null',
    async () => {
      render(<MatchCard matchId="match-1" />);
      await screen.findByText('Нет доступа к боевым событиям.');
    },
    TEST_TIMEOUT_MS,
  );
});
