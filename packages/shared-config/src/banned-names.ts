export const BANNED_NAME_MATCH_TYPES = ['exact', 'substring', 'regex'] as const;
export type BannedNameMatchType = (typeof BANNED_NAME_MATCH_TYPES)[number];

export const BANNED_NAME_ACTIONS = ['kick', 'alert'] as const;
export type BannedNameAction = (typeof BANNED_NAME_ACTIONS)[number];

export const BANNED_NAME_PATTERN_MAX = 256;

const MATCH_TYPE_SET: ReadonlySet<string> = new Set(BANNED_NAME_MATCH_TYPES);
const ACTION_SET: ReadonlySet<string> = new Set(BANNED_NAME_ACTIONS);

export function isBannedNameMatchType(x: string): x is BannedNameMatchType {
  return MATCH_TYPE_SET.has(x);
}

export function isBannedNameAction(x: string): x is BannedNameAction {
  return ACTION_SET.has(x);
}

export type BannedNameValidation = { ok: true } | { ok: false; error: string };

export function validateBannedNamePattern(
  pattern: string,
  matchType: BannedNameMatchType,
): BannedNameValidation {
  if (pattern.length === 0) {
    return { ok: false, error: 'pattern_empty' };
  }
  if (pattern.length > BANNED_NAME_PATTERN_MAX) {
    return { ok: false, error: `pattern_too_long: max ${BANNED_NAME_PATTERN_MAX} characters` };
  }
  if (matchType === 'regex') {
    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: true };
}

export function matchBannedName(
  pattern: string,
  matchType: BannedNameMatchType,
  nickname: string,
): boolean {
  if (pattern.length === 0) return false;
  if (matchType === 'exact') {
    return nickname.toLowerCase() === pattern.toLowerCase();
  }
  if (matchType === 'substring') {
    return nickname.toLowerCase().includes(pattern.toLowerCase());
  }
  try {
    // Case-insensitive to match the log-ingest worker's compiled regex
    // matcher (apps/workers/log-ingest/src/banname/matcher.ts), so this
    // preview/check never disagrees with what actually gets enforced.
    return new RegExp(pattern, 'i').test(nickname);
  } catch {
    return false;
  }
}

/** Minimal shape `findBannedNameRuleMatch` needs from a `banned_name_rules` row. */
export interface BannedNameRuleForMatch {
  id: string;
  pattern: string;
  match_type: BannedNameMatchType;
  action: BannedNameAction;
  reason: string | null;
}

/**
 * Finds the first rule matching `nickname`, mirroring the log-ingest worker's
 * evaluation order: exact rules first, then substring, then regex; within a
 * tier, rules are tried in the order they appear in `rules` (callers should
 * pass rules pre-sorted by `created_at`, `id` ascending, and pre-filtered to
 * active rules only — the same order `BannedNameRuleCache` loads). Invalid
 * regex rules never match (matchBannedName swallows compile errors) rather
 * than throwing, so one bad rule can't break a check for every other rule.
 */
export function findBannedNameRuleMatch<T extends BannedNameRuleForMatch>(
  rules: readonly T[],
  nickname: string,
): T | null {
  const buckets: Record<BannedNameMatchType, T[]> = { exact: [], substring: [], regex: [] };
  for (const rule of rules) {
    if (!isBannedNameMatchType(rule.match_type)) continue;
    buckets[rule.match_type].push(rule);
  }
  for (const tier of [buckets.exact, buckets.substring, buckets.regex]) {
    for (const rule of tier) {
      if (matchBannedName(rule.pattern, rule.match_type, nickname)) return rule;
    }
  }
  return null;
}
