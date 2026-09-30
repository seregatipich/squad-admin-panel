import { isFiniteNumber, isNullableString, isRecord } from '@/lib/json-guards';

/** How many partners the «Часто играет с» card lists. */
export const COPLAY_CARD_LIMIT = 10;

export interface CoplayPartner {
  player_id: string;
  player_name: string | null;
  overlap_seconds: number;
  shared_session_count: number;
}

/**
 * The card's request: exactly {@link COPLAY_CARD_LIMIT} partners and no
 * per-server breakdown, which the API computes only for `?include=by_server`
 * (#453).
 */
export function coplayUrl(playerId: string): string {
  return `/api/v1/players/${encodeURIComponent(playerId)}/coplay?limit=${COPLAY_CARD_LIMIT}`;
}

function isCoplayPartner(value: unknown): value is CoplayPartner {
  return (
    isRecord(value) &&
    typeof value.player_id === 'string' &&
    isNullableString(value.player_name) &&
    isFiniteNumber(value.overlap_seconds) &&
    isFiniteNumber(value.shared_session_count)
  );
}

/** The partners of a decoded coplay body, or `null` when its shape is wrong (#456). */
export function parseCoplayPartners(json: unknown): CoplayPartner[] | null {
  if (!isRecord(json) || !Array.isArray(json.partners)) return null;
  if (!json.partners.every(isCoplayPartner)) return null;
  return json.partners.map((partner) => ({
    player_id: partner.player_id,
    player_name: partner.player_name,
    overlap_seconds: partner.overlap_seconds,
    shared_session_count: partner.shared_session_count,
  }));
}
