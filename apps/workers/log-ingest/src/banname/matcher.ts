import {
  BANNED_NAME_PATTERN_MAX,
  type BannedNameAction,
  type BannedNameMatchType,
} from '@squad/shared-config/banned-names';

/** One row read from `banned_name_rules`, as needed to compile a matcher. */
export interface BannedNameRuleRow {
  id: string;
  pattern: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
}

interface CompiledBannedNameRule {
  id: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
  test: (nickname: string) => boolean;
}

/**
 * Rules compiled and bucketed by match tier. Evaluation order is
 * exact -> substring -> regex, first match wins (BANNAME-2 acceptance
 * criteria); within a tier, rules are tested in the order they were
 * compiled, which the cache loads in `created_at` (then `id`) order.
 */
export interface CompiledBannedNameRuleSet {
  exact: CompiledBannedNameRule[];
  substring: CompiledBannedNameRule[];
  regex: CompiledBannedNameRule[];
}

export interface BannedNameMatch {
  ruleId: string;
  matchType: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
}

function compileBannedNameRule(row: BannedNameRuleRow): CompiledBannedNameRule | null {
  const pattern = row.pattern.trim();
  if (pattern.length === 0 || pattern.length > BANNED_NAME_PATTERN_MAX) return null;

  if (row.matchType === 'exact') {
    const lowered = pattern.toLowerCase();
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => nickname.toLowerCase() === lowered,
    };
  }

  if (row.matchType === 'substring') {
    const lowered = pattern.toLowerCase();
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => nickname.toLowerCase().includes(lowered),
    };
  }

  try {
    const regex = new RegExp(pattern, 'i');
    return {
      id: row.id,
      matchType: row.matchType,
      reason: row.reason,
      action: row.action,
      test: (nickname) => regex.test(nickname),
    };
  } catch {
    // Invalid regex rules are dropped silently: one bad rule must never
    // break ingestion for every other rule/player.
    return null;
  }
}

/** Compiles active rule rows into the tiered set `matchBannedNickname` evaluates. */
export function compileBannedNameRules(rows: BannedNameRuleRow[]): CompiledBannedNameRuleSet {
  const compiled: CompiledBannedNameRuleSet = { exact: [], substring: [], regex: [] };
  for (const row of rows) {
    const rule = compileBannedNameRule(row);
    if (!rule) continue;
    compiled[rule.matchType].push(rule);
  }
  return compiled;
}

/**
 * Runs a nickname through the compiled rule set: exact rules first, then
 * substring, then regex; returns the first match or null. Matching is
 * case-insensitive for every match type.
 */
export function matchBannedNickname(
  nickname: string,
  compiled: CompiledBannedNameRuleSet,
): BannedNameMatch | null {
  for (const tier of [compiled.exact, compiled.substring, compiled.regex]) {
    for (const rule of tier) {
      if (rule.test(nickname)) {
        return {
          ruleId: rule.id,
          matchType: rule.matchType,
          reason: rule.reason,
          action: rule.action,
        };
      }
    }
  }
  return null;
}
