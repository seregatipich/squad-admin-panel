import {
  ALT_DETECTION_DEFAULT_WEIGHT_SHARED_IP,
  ALT_DETECTION_DEFAULT_WEIGHT_SHARED_NAME,
  ALT_DETECTION_DEFAULT_WEIGHT_STEAMID_PROXIMITY,
  ALT_DETECTION_DEFAULT_WEIGHT_YOUNG_ACCOUNT,
} from '@squad/db/schema';

/**
 * Confidence band assigned to a candidate once its score has been computed.
 * `high` sorts most likely to be a genuine alt/twink of the target player.
 */
export type AltConfidence = 'low' | 'medium' | 'high';

/**
 * On/off inputs to {@link computeAltScore}. Each field is already resolved
 * to whatever unit the caller needs (a count for the two "how many" signals,
 * a boolean for the two "is it true" signals) — the score formula itself
 * only cares whether each signal is present, not its magnitude.
 */
export interface AltScoreSignals {
  /** Count of *non-ignored* shared-IP matches (0 if none, or if every match is on the ignore list). */
  sharedIpCount: number;
  /** Count of historical nicknames the target and candidate share. */
  sharedNameCount: number;
  /** Candidate account created after the target's most recent ban. */
  youngAccount: boolean;
  /** Both accounts have a SteamID64 and their delta is below the configured threshold. */
  steamidClose: boolean;
}

export interface AltScoreWeights {
  weightSharedIp: number;
  weightSharedName: number;
  weightYoungAccount: number;
  weightSteamidProximity: number;
}

export interface AltConfidenceThresholds {
  mediumThreshold: number;
  highThreshold: number;
}

export const DEFAULT_ALT_SCORE_WEIGHTS: AltScoreWeights = {
  weightSharedIp: ALT_DETECTION_DEFAULT_WEIGHT_SHARED_IP,
  weightSharedName: ALT_DETECTION_DEFAULT_WEIGHT_SHARED_NAME,
  weightYoungAccount: ALT_DETECTION_DEFAULT_WEIGHT_YOUNG_ACCOUNT,
  weightSteamidProximity: ALT_DETECTION_DEFAULT_WEIGHT_STEAMID_PROXIMITY,
};

/**
 * Computes a candidate's alt-detection score: the sum of the weights of
 * every triggered signal. Each signal contributes its configured weight at
 * most once — a candidate with five shared (non-ignored) IPs scores the same
 * `weightSharedIp` contribution as one with a single shared IP, and a
 * candidate whose only shared IPs are all on the ignore list (`sharedIpCount
 * === 0`) contributes nothing for the IP signal, even though the ignored
 * matches still render in the response for context.
 */
export function computeAltScore(signals: AltScoreSignals, weights: AltScoreWeights): number {
  let score = 0;
  if (signals.sharedIpCount > 0) score += weights.weightSharedIp;
  if (signals.sharedNameCount > 0) score += weights.weightSharedName;
  if (signals.youngAccount) score += weights.weightYoungAccount;
  if (signals.steamidClose) score += weights.weightSteamidProximity;
  return score;
}

/**
 * Maps a score to a confidence band using the two configured cutoffs.
 * Boundaries are inclusive on the lower end: a score exactly at
 * `mediumThreshold` is `medium`, and one exactly at `highThreshold` is `high`.
 */
export function confidenceFor(score: number, thresholds: AltConfidenceThresholds): AltConfidence {
  if (score >= thresholds.highThreshold) return 'high';
  if (score >= thresholds.mediumThreshold) return 'medium';
  return 'low';
}
