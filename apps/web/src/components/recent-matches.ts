export type MatchOutcome = 'win' | 'loss' | 'draw' | null;

export interface RecentMatch {
  match_id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  layer: string | null;
  map: string | null;
  game_mode: string | null;
  winner: string | null;
  is_seed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  team: number | null;
  play_seconds: number;
  outcome: MatchOutcome;
}

export interface Winrate {
  wins: number;
  losses: number;
  draws: number;
  decided: number;
  considered: number;
  window: number;
}

export interface MatchSummary {
  recent: RecentMatch[];
  winrate: Winrate;
}

const OUTCOME_LABELS: Record<Exclude<MatchOutcome, null>, string> = {
  win: 'Победа',
  loss: 'Поражение',
  draw: 'Ничья',
};

export function outcomeLabel(outcome: MatchOutcome): string {
  if (outcome === null) return 'В процессе';
  return OUTCOME_LABELS[outcome];
}

export function winrateSummaryText(winrate: Winrate): string {
  return `Побед ${winrate.wins} из ${winrate.decided}`;
}

export function winratePercent(winrate: Winrate): number | null {
  if (winrate.decided === 0) return null;
  return Math.round((winrate.wins / winrate.decided) * 100);
}

export function allMatchesHref(playerId: string): string {
  return `/matches?player=${encodeURIComponent(playerId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

function isRecentMatch(value: unknown): value is RecentMatch {
  if (!isRecord(value)) return false;
  return (
    typeof value.match_id === 'string' &&
    typeof value.server_id === 'string' &&
    isNullableString(value.server_name) &&
    isNullableString(value.server_slug) &&
    isNullableString(value.layer) &&
    isNullableString(value.map) &&
    isNullableString(value.game_mode) &&
    isNullableString(value.winner) &&
    typeof value.is_seed === 'boolean' &&
    typeof value.started_at === 'string' &&
    isNullableString(value.ended_at) &&
    isNullableNumber(value.duration_seconds) &&
    isNullableNumber(value.team) &&
    typeof value.play_seconds === 'number' &&
    (value.outcome === null ||
      (typeof value.outcome === 'string' && value.outcome in OUTCOME_LABELS))
  );
}

function isWinrate(value: unknown): value is Winrate {
  if (!isRecord(value)) return false;
  return (
    typeof value.wins === 'number' &&
    typeof value.losses === 'number' &&
    typeof value.draws === 'number' &&
    typeof value.decided === 'number' &&
    typeof value.considered === 'number' &&
    typeof value.window === 'number'
  );
}

/**
 * Validates a `GET /api/v1/players/:id/match-summary` body.
 *
 * @param value Parsed JSON of unknown shape.
 * @returns The summary, or `null` when the shape does not match the contract.
 */
export function parseMatchSummary(value: unknown): MatchSummary | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.recent) || !value.recent.every(isRecentMatch)) return null;
  if (!isWinrate(value.winrate)) return null;
  return { recent: value.recent, winrate: value.winrate };
}
