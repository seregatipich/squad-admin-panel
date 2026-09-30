import { apiFetch } from '@/lib/api';
import { forwardedClientHeaders } from '@/lib/forwarded-client';

/** Aggregate payload served by the public, no-session `GET /api/v1/public/stats` route. */
export interface PublicStats {
  from: string;
  to: string;
  summary: {
    total_matches: number;
    total_online_hours: number;
    unique_players: number;
    avg_match_duration_seconds: number | null;
  };
  peak_by_hour: Array<{ hour: number; peak_players: number }>;
  match_outcomes: {
    team1: number;
    team2: number;
    draw: number;
    unknown: number;
    total: number;
  };
  popular_maps: Array<{ map: string; matches: number }>;
  popular_layers: Array<{ layer: string; matches: number }>;
}

/**
 * Server-side fetch of the public stats portal data. Deliberately makes no
 * request with session credentials — the API route is anonymous-accessible,
 * and this page must render the same for every visitor. It does relay the
 * visitor's IP so the API rate-limits each visitor, not the web container.
 */
export async function getPublicStats(): Promise<PublicStats> {
  return apiFetch<PublicStats>('/api/v1/public/stats', {
    headers: await forwardedClientHeaders(),
  });
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function peakScale(peakByHour: Array<{ peak_players: number }>): number {
  return peakByHour.reduce((max, entry) => Math.max(max, entry.peak_players), 0) || 1;
}

export { formatDurationRu, formatHours } from '@/lib/format';
