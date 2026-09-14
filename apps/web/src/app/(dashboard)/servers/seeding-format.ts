/**
 * Pure formatting helpers for the seeding progress shown on the servers list
 * (`page.tsx`) (SEED-1, #140). Kept free of React/DOM so the "N / live_at"
 * string logic is unit-testable on its own.
 */

export interface SeedingSummary {
  state: 'seeding' | 'live' | 'unknown';
  current_players: number | null;
  live_at: number | null;
  progress_pct: number | null;
  started_at: string | null;
}

/** Renders "N / live_at" for the progress label, or "—" when either value is unknown. */
export function formatSeedProgress(currentPlayers: number | null, liveAt: number | null): string {
  if (currentPlayers == null || liveAt == null) return '—';
  return `${currentPlayers} / ${liveAt}`;
}
