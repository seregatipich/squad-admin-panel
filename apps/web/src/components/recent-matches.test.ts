import { describe, expect, it } from 'vitest';
import {
  allMatchesHref,
  outcomeLabel,
  parseMatchSummary,
  type RecentMatch,
  type Winrate,
  winratePercent,
  winrateSummaryText,
} from './recent-matches';

function winrate(overrides: Partial<Winrate> = {}): Winrate {
  return { wins: 0, losses: 0, draws: 0, decided: 0, considered: 0, window: 30, ...overrides };
}

describe('outcomeLabel', () => {
  it('maps every outcome to its Russian label', () => {
    expect(outcomeLabel('win')).toBe('Победа');
    expect(outcomeLabel('loss')).toBe('Поражение');
    expect(outcomeLabel('draw')).toBe('Ничья');
    expect(outcomeLabel(null)).toBe('В процессе');
  });
});

describe('winrateSummaryText', () => {
  it('reads "Побед X из Y" over decided matches', () => {
    expect(winrateSummaryText(winrate({ wins: 7, decided: 12 }))).toBe('Побед 7 из 12');
    expect(winrateSummaryText(winrate())).toBe('Побед 0 из 0');
  });
});

describe('winratePercent', () => {
  it('rounds the win share and returns null with no decided matches', () => {
    expect(winratePercent(winrate({ wins: 1, decided: 2 }))).toBe(50);
    expect(winratePercent(winrate({ wins: 2, decided: 3 }))).toBe(67);
    expect(winratePercent(winrate())).toBeNull();
  });
});

describe('allMatchesHref', () => {
  it('points to the matches list pre-filtered by player', () => {
    expect(allMatchesHref('11111111-2222-3333-4444-555555555555')).toBe(
      '/matches?player=11111111-2222-3333-4444-555555555555',
    );
  });
});

describe('RecentMatch shape', () => {
  it('carries the per-player fields needed to render a row', () => {
    const row: RecentMatch = {
      match_id: 'm1',
      server_id: 's1',
      server_name: 'EU',
      server_slug: 'eu',
      layer: 'Yehorivka_RAAS_v1',
      map: 'Yehorivka',
      game_mode: 'RAAS',
      winner: 'team1',
      is_seed: false,
      started_at: '2026-06-01T10:00:00.000Z',
      ended_at: '2026-06-01T11:00:00.000Z',
      duration_seconds: 3600,
      team: 1,
      play_seconds: 3000,
      outcome: 'win',
    };
    expect(outcomeLabel(row.outcome)).toBe('Победа');
  });
});

describe('parseMatchSummary', () => {
  const row = {
    match_id: 'm1',
    server_id: 's1',
    server_name: 'EU',
    server_slug: 'eu',
    layer: null,
    map: null,
    game_mode: null,
    winner: null,
    is_seed: false,
    started_at: '2026-06-01T10:00:00.000Z',
    ended_at: null,
    duration_seconds: null,
    team: null,
    play_seconds: 3000,
    outcome: null,
  };
  const wr = { wins: 1, losses: 0, draws: 0, decided: 1, considered: 1, window: 30 };

  it('accepts a well-formed summary', () => {
    expect(parseMatchSummary({ recent: [row], winrate: wr })).toEqual({
      recent: [row],
      winrate: wr,
    });
  });

  it('rejects payloads of the wrong shape instead of letting render crash', () => {
    expect(parseMatchSummary(null)).toBeNull();
    expect(parseMatchSummary({})).toBeNull();
    expect(parseMatchSummary({ recent: 'x', winrate: wr })).toBeNull();
    expect(parseMatchSummary({ recent: [row], winrate: null })).toBeNull();
    expect(parseMatchSummary({ recent: [{ ...row, outcome: 'nope' }], winrate: wr })).toBeNull();
    expect(parseMatchSummary({ recent: [], winrate: { ...wr, decided: '1' } })).toBeNull();
  });
});
