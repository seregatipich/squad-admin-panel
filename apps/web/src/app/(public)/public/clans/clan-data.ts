import { apiFetch } from '@/lib/api';

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

/** Loads one public clan page; the API returns 404 when visibility is disabled. */
export async function getPublicClan(id: string): Promise<PublicClan> {
  return apiFetch<PublicClan>(`/api/v1/public/clans/${encodeURIComponent(id)}`);
}

export function formatOnlineHours(seconds: number): string {
  return `${(Math.max(0, seconds) / 3600).toFixed(1).replace('.', ',')} ч`;
}
