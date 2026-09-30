import { isFiniteNumber, isRecord } from '@/lib/json-guards';

export interface PlayerVoteStats {
  player_id: string;
  initiated: number;
  participated: number;
  serial_skipper: {
    flagged: boolean;
    skip_count: number;
    threshold: number;
    window_days: number;
  };
}

export function serialSkipperLabel(skipper: PlayerVoteStats['serial_skipper']): string {
  return `${skipper.skip_count} скипов за ${skipper.window_days} дн. (порог ${skipper.threshold})`;
}

export function voteStatsUrl(playerId: string): string {
  return `/api/v1/players/${encodeURIComponent(playerId)}/vote-stats`;
}

/**
 * Validates a decoded vote-stats body (by the pattern of
 * `parseSeedContribution`), returning `null` for any shape mismatch so an
 * unexpected answer renders as an error instead of crashing the card (#468).
 */
export function parsePlayerVoteStats(json: unknown): PlayerVoteStats | null {
  if (!isRecord(json)) return null;
  const { player_id: playerId, initiated, participated, serial_skipper: skipper } = json;
  if (typeof playerId !== 'string' || !isFiniteNumber(initiated) || !isFiniteNumber(participated)) {
    return null;
  }
  if (
    !isRecord(skipper) ||
    typeof skipper.flagged !== 'boolean' ||
    !isFiniteNumber(skipper.skip_count) ||
    !isFiniteNumber(skipper.threshold) ||
    !isFiniteNumber(skipper.window_days)
  ) {
    return null;
  }
  return {
    player_id: playerId,
    initiated,
    participated,
    serial_skipper: {
      flagged: skipper.flagged,
      skip_count: skipper.skip_count,
      threshold: skipper.threshold,
      window_days: skipper.window_days,
    },
  };
}
