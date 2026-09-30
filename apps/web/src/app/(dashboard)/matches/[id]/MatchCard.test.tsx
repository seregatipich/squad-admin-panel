// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchDetail } from '../helpers';
import { MatchCard } from './MatchCard';

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

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
  liveHandlers.clear();
});

describe('MatchCard', () => {
  it('is a valid React component', () => {
    expect(MatchCard).toBeDefined();
    expect(typeof MatchCard).toBe('function');
  });

  it(
    'marks the roster row of a player who left before the match ended, and leaves the full-time row unmarked',
    async () => {
      render(<MatchCard matchId="018f1e3a-6f3e-7c3e-9a3e-1234567890ab" />);
      const earlyRow = (await screen.findByText('EarlyLeaver')).closest('tr');
      expect(earlyRow).not.toBeNull();
      // Состояние строки названо словами, а не одной лишь приглушённостью.
      expect(within(earlyRow as HTMLElement).getByText('ушёл раньше')).toBeInTheDocument();

      const fullTimeRow = screen.getByText('FullTimer').closest('tr');
      expect(fullTimeRow).not.toBeNull();
      expect(within(fullTimeRow as HTMLElement).queryByText('ушёл раньше')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the dimmed player link clickable to their player card',
    async () => {
      render(<MatchCard matchId="018f1e3a-6f3e-7c3e-9a3e-1234567890ab" />);
      const earlyLink = await screen.findByText('EarlyLeaver');
      expect(earlyLink.closest('a')).toHaveAttribute('href', '/all-players/player-left-early');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders null combat stats as "—" instead of substituting 0',
    async () => {
      render(<MatchCard matchId="018f1e3a-6f3e-7c3e-9a3e-1234567890ab" />);
      await screen.findByText('EarlyLeaver');
      const earlyRow = screen.getByText('EarlyLeaver').closest('tr') as HTMLElement;
      const dashes = within(earlyRow)
        .getAllByRole('cell')
        .filter((cell) => cell.textContent === '—');
      // K/D, TK, ранения, поднятия — четыре ненаписанных показателя.
      expect(dashes).toHaveLength(4);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the no-access state when combat_events is null',
    async () => {
      render(<MatchCard matchId="018f1e3a-6f3e-7c3e-9a3e-1234567890ab" />);
      await screen.findByText('Нет доступа к боевым событиям.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a non-UUID matchId instead of ever fetching it (#587)',
    async () => {
      const fetchMock = vi.fn(() => Promise.reject(new Error('should not be called')));
      vi.stubGlobal('fetch', fetchMock);

      render(<MatchCard matchId="../other-route" />);

      await screen.findByText('Некорректный идентификатор матча');
      expect(fetchMock).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refetches once the live bus reports this exact match has ended (#583)',
    async () => {
      const matchId = '018f1e3a-6f3e-7c3e-9a3e-1234567890ab';
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(matchDetail({ ended_at: null, duration_seconds: null })), {
            status: 200,
          }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      render(<MatchCard matchId={matchId} />);
      await screen.findByText('FullTimer');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // An unrelated match ending must not trigger a refetch.
      liveHandlers.get('match.ended')?.({ data: { server_id: 'srv-1', match_id: 'other-match' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      liveHandlers.get('match.ended')?.({ data: { server_id: 'srv-1', match_id: matchId } });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    },
    TEST_TIMEOUT_MS,
  );
});
