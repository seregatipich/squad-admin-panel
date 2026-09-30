import { ApiError, apiFetch } from '@/lib/api';

export interface PublicClanSummary {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
}

export interface PublicClan {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  roster: Array<{ nickname: string; role: string }>;
  activity: Array<{ day: string; online_seconds: number }>;
  stats: {
    from: string;
    to: string;
    roster_size: number;
    online_seconds: number;
    matches_played: number;
    matches_total: number;
    kills: number;
    deaths: number;
    revives: number;
    kd: number;
  };
  matches: Array<{
    id: string;
    map: string | null;
    layer: string | null;
    winner: string | null;
    is_seed: boolean;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
  }>;
}

/** Loads the PII-free anonymous clan directory. */
export async function getPublicClans(): Promise<{ items: PublicClanSummary[]; total: number }> {
  return apiFetch('/api/v1/public/clans');
}

/**
 * Loads one public clan page. The API returns 404 when the clan is unknown or
 * its visibility is disabled, which resolves to `null`; every other failure
 * (429, 5xx, network) is rethrown so the error boundary can show it.
 */
export async function getPublicClan(id: string): Promise<PublicClan | null> {
  try {
    return await apiFetch<PublicClan>(`/api/v1/public/clans/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function formatOnlineHours(seconds: number): string {
  return `${(Math.max(0, seconds) / 3600).toFixed(1).replace('.', ',')} ч`;
}
