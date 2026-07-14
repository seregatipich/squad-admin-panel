/**
 * Pure formatting helpers for the seeding badge/progress-bar shared by the
 * servers list (`page.tsx`) and server detail (`[id]/SeedingBadge.tsx`) pages
 * (SEED-1, #140). Kept free of React/DOM so both call sites can share exact
 * formatting without duplicating the "N / live_at" string logic.
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

/** Clamps a progress percentage into the renderable 0..100 range, defaulting to 0 when unknown. */
export function clampProgressPct(progressPct: number | null | undefined): number {
  if (progressPct == null || Number.isNaN(progressPct)) return 0;
  return Math.min(100, Math.max(0, progressPct));
}
