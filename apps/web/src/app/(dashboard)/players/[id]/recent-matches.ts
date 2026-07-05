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

const OUTCOME_TONES: Record<Exclude<MatchOutcome, null>, string> = {
  win: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  loss: 'border-red-900 bg-red-950/50 text-red-300',
  draw: 'border-neutral-800 bg-neutral-900 text-neutral-400',
};

const NEUTRAL_TONE = 'border-neutral-800 bg-neutral-900 text-neutral-500';

export function outcomeLabel(outcome: MatchOutcome): string {
  if (outcome === null) return 'В процессе';
  return OUTCOME_LABELS[outcome];
}

export function outcomeToneClasses(outcome: MatchOutcome): string {
  if (outcome === null) return NEUTRAL_TONE;
  return OUTCOME_TONES[outcome];
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

export function serverLabel(match: Pick<RecentMatch, 'server_slug' | 'server_name'>): string {
  return match.server_slug ?? match.server_name ?? '—';
}

export function formatMatchDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${secs}с`;
  return `${secs}с`;
}

export function formatMatchDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
