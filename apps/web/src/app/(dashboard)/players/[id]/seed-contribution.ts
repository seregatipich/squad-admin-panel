export interface SeedContributionWindow {
  from: string;
  to: string;
  days: number;
}

export interface SeedServerContribution {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  seed_seconds: number;
}

export interface SeedContributionSeriesPoint {
  day: string;
  seed_seconds: number;
}

export interface SeedContributionBonus {
  k_seed: number;
  earned_points: number;
}

export interface SeedContributionResponse {
  window: SeedContributionWindow;
  total_seed_seconds: number;
  by_server: SeedServerContribution[];
  series: SeedContributionSeriesPoint[];
  bonus: SeedContributionBonus;
}

export const DEFAULT_SEED_CONTRIBUTION_DAYS = 30;

/** Builds the `GET /api/v1/players/:playerId/seed-contribution` path. */
export function buildSeedContributionUrl(
  playerId: string,
  days: number = DEFAULT_SEED_CONTRIBUTION_DAYS,
): string {
  return `/api/v1/players/${playerId}/seed-contribution?days=${days}`;
}

/** Formats seconds as `«XXч XXм»` (Russian hour/minute suffixes), floored to the minute. */
export function formatSeedDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0ч 0м';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}ч ${minutes}м`;
}

function isServerContribution(value: unknown): value is SeedServerContribution {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.server_id === 'string' &&
    (row.server_name === null || typeof row.server_name === 'string') &&
    (row.server_slug === null || typeof row.server_slug === 'string') &&
    typeof row.seed_seconds === 'number'
  );
}

function isSeriesPoint(value: unknown): value is SeedContributionSeriesPoint {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.day === 'string' && typeof row.seed_seconds === 'number';
}

/**
 * Validates and narrows a decoded JSON response body from the
 * seed-contribution API into a {@link SeedContributionResponse}, or returns
 * `null` when the shape doesn't match (defensively — the API is trusted but
 * this keeps a malformed/partial response from crashing the section).
 */
export function parseSeedContribution(json: unknown): SeedContributionResponse | null {
  if (!json || typeof json !== 'object') return null;
  const value = json as Record<string, unknown>;

  const window = value.window as Record<string, unknown> | undefined;
  if (
    !window ||
    typeof window !== 'object' ||
    typeof window.from !== 'string' ||
    typeof window.to !== 'string' ||
    typeof window.days !== 'number'
  ) {
    return null;
  }

  const bonus = value.bonus as Record<string, unknown> | undefined;
  if (
    !bonus ||
    typeof bonus !== 'object' ||
    typeof bonus.k_seed !== 'number' ||
    typeof bonus.earned_points !== 'number'
  ) {
    return null;
  }

  if (typeof value.total_seed_seconds !== 'number') return null;
  if (!Array.isArray(value.by_server) || !value.by_server.every(isServerContribution)) {
    return null;
  }
  if (!Array.isArray(value.series) || !value.series.every(isSeriesPoint)) return null;

  return {
    window: { from: window.from, to: window.to, days: window.days },
    total_seed_seconds: value.total_seed_seconds,
    by_server: value.by_server,
    series: value.series,
    bonus: { k_seed: bonus.k_seed, earned_points: bonus.earned_points },
  };
}

export function serverLabel(
  server: Pick<SeedServerContribution, 'server_slug' | 'server_name'>,
): string {
  return server.server_slug ?? server.server_name ?? '—';
}

export function sortServersBySeedSeconds(
  servers: SeedServerContribution[],
): SeedServerContribution[] {
  return [...servers].sort((a, b) => {
    if (b.seed_seconds !== a.seed_seconds) return b.seed_seconds - a.seed_seconds;
    return serverLabel(a).localeCompare(serverLabel(b));
  });
}
