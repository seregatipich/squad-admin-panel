import { describe, expect, it } from 'vitest';
import {
  allMatchesHref,
  formatMatchDuration,
  outcomeLabel,
  outcomeToneClasses,
  type RecentMatch,
  serverLabel,
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

describe('outcomeToneClasses', () => {
  it('gives distinct tones for win/loss and a neutral tone otherwise', () => {
    expect(outcomeToneClasses('win')).toContain('emerald');
    expect(outcomeToneClasses('loss')).toContain('red');
    expect(outcomeToneClasses('draw')).toContain('neutral');
    expect(outcomeToneClasses(null)).toContain('neutral');
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

describe('serverLabel', () => {
  it('prefers slug, falls back to name, then dash', () => {
    expect(serverLabel({ server_slug: 'eu-1', server_name: 'EU Main' })).toBe('eu-1');
    expect(serverLabel({ server_slug: null, server_name: 'EU Main' })).toBe('EU Main');
    expect(serverLabel({ server_slug: null, server_name: null })).toBe('—');
  });
});

describe('formatMatchDuration', () => {
  it('formats hours, minutes, seconds and guards invalid input', () => {
    expect(formatMatchDuration(3661)).toBe('1ч 1м');
    expect(formatMatchDuration(125)).toBe('2м 5с');
    expect(formatMatchDuration(42)).toBe('42с');
    expect(formatMatchDuration(null)).toBe('—');
    expect(formatMatchDuration(-5)).toBe('—');
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
    expect(formatMatchDuration(row.play_seconds)).toBe('50м 0с');
  });
});
